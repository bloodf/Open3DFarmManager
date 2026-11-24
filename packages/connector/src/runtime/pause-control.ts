import type { MacroParamMap } from '../moonraker/control-macros.ts'
import {
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import { receiveApiCommand } from './api-command.ts'
import {
  ApiResinReplay,
  decodeApiEnvelopeFrame,
  encodeApiEnvelopeResultFrame,
} from '../../../farm-protocol/src/api-envelope.ts'
import { PAUSE_POLICY_HARD_MAXIMUMS } from '../../../farm-protocol/src/pause-capability.ts'
import {
  controlEffectMatches,
  type ControlObservation,
} from '../control/pause-dispatcher.ts'
import type { ControlAction } from '../../../farm-protocol/src/control-actions.ts'
import {
  openTrustedKeyStore,
  type TrustedKeyAuthority,
} from '../auth/trusted-key-store.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readBambuCredentials } from '../bambu/credentials.ts'
import {
  moonrakerAuthHeaders,
  validateMoonrakerInput,
} from '../config/moonraker.ts'
import { join } from 'node:path'
import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../control/command-journal.ts'
import {
  createPauseCommandRelay,
  type PauseRelayOutcome,
  type PauseRelayReason,
} from '../control/pause-command-relay.ts'
import { loadPauseIssuerKeys } from '../config/pause.ts'
import { credentialLookupId } from '../config/signalling.ts'
import type { AgentRuntimeConfig } from '../config/runtime.ts'
import type { RuntimeCredential } from '../config/credential.ts'
import type { ConnectorIdentity } from '../identity/store.ts'
import type { CachedAuthorityFreshness } from '../auth/offline-authority.ts'
import {
  PauseConnectorSignallingClient,
  type PauseConnectorSignallingScope,
} from '../cloud/pause-signalling-client.ts'
import { createPauseDriverRouter } from './pause-driver-router.ts'
import { createFileTargets } from './file-targets.ts'
import type { FileUploadTarget } from './file-upload.ts'
import { withLibraryPrint } from './library-print-start.ts'
import { withCollectionHold } from '../control/queue-collection-hold.ts'
import type { QueueCollectionJournal } from '../control/queue-collection-journal.ts'
import { runSignallingLifecycle } from './signalling.ts'

export type PauseControlDiagnostic =
  | { kind: 'pause-listening' }
  | { kind: 'pause-admitted' }
  | { kind: 'pause-denied'; reason: string }
  | {
      kind: 'pause-outcome'
      outcome: PauseRelayOutcome
      /** Fixed relay reason of the latest settled command, never free text. */
      reason: PauseRelayReason | undefined
    }
  | { kind: 'pause-terminal'; reason: string }
  | { kind: 'pause-close-stalled'; waitedMs: number }

type ClientOptions = NonNullable<
  ConstructorParameters<typeof PauseConnectorSignallingClient>[1]
>
type PauseClient = Pick<
  PauseConnectorSignallingClient,
  'start' | 'close' | 'dispose' | 'sendPhase' | 'sendResult'
>

/** Fixed classification of a pause-path failure; no free text leaves the path. */
export type PauseFailureReason = 'journal' | 'credential' | 'runtime'
class PauseControlError extends Error {
  readonly reason: PauseFailureReason
  constructor(reason: PauseFailureReason) {
    super('Pause control ' + reason + ' failure')
    this.reason = reason
  }
}
export function pauseFailureReason(error: unknown): PauseFailureReason {
  return error instanceof PauseControlError ? error.reason : 'runtime'
}
function classified<T>(reason: PauseFailureReason, run: () => T): T {
  try {
    return run()
  } catch {
    throw new PauseControlError(reason)
  }
}

const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30000
/** Shutdown waits this long for driver settlement before reporting a stall. */
export const PAUSE_CLOSE_STALL_MS = 10000

function label(reason: string): string {
  return /^[a-zA-Z0-9:_-]{1,80}$/.test(reason) ? reason : 'unclassified'
}

export function refuseApiCommand(
  frame: Parameters<typeof receiveApiCommand>[1],
  inbox: Parameters<typeof receiveApiCommand>[2],
  code: 'printer-busy' | 'not-ready' | 'unsupported',
) {
  try {
    const { envelope } = decodeApiEnvelopeFrame(frame.wire)
    inbox.report(
      encodeApiEnvelopeResultFrame({
        v: 1,
        t: 'api-envelope.result',
        cmd_id: envelope.cmd_id,
        outcome: 'refused',
        refusal_code: code,
        ...(code === 'unsupported' &&
        ApiResinReplay.safeParse(envelope.action).success
          ? { detail: 'resin-artifact-dispatch-unavailable' }
          : {}),
        at: Date.now(),
      }),
    )
  } catch {
    // Reporting a refusal must not disrupt inbox processing.
  }
}

/**
 * Production pause control path, composed exactly like the verified execution
 * fixture: authenticated pause RTC proofs open a relay peer; the relay verifies
 * the issued capability and the signed command, claims the durable local
 * journal (replay and busy refusal), and only then prepares the fixed Moonraker
 * driver for its locally provisioned assignment. Every command runs at
 * most once: nothing is retried, queued or sent over HTTP.
 *
 * Runs until `signal` aborts or the credential expires, then closes the relay
 * and keeps the journal open until every driver attempt actually settled.
 */
type PauseControlInput = {
  config: AgentRuntimeConfig
  credential: RuntimeCredential
  identity: ConnectorIdentity
  dataDirectory: string
  signal: AbortSignal
  onDiagnostic(value: PauseControlDiagnostic): void
  /** Read-only capabilities from the same router used by the relay. */
  onMacroParams?: (
    read: (assignmentId: string) => MacroParamMap | undefined,
  ) => void
  onMacros?: (
    read: (assignmentId: string) => readonly string[] | undefined,
  ) => void
  onControls?: (
    read: (assignmentId: string) => readonly ExtendedControlAction[],
  ) => void
  /**
   * Required offline lifetime gate: the frozen read-only view from
   * `createOfflineAuthority()`. Stale authority rejects every command.
   */
  trustedKeys?: TrustedKeyAuthority
  apiHandlers?: Map<
    string,
    (
      frame: Parameters<typeof receiveApiCommand>[1],
      inbox: Parameters<typeof receiveApiCommand>[2],
    ) => void
  >
  freshness: CachedAuthorityFreshness
  /** Library print starter of one assignment (#384); absent: `start_library_print` is refused as unsupported. */
  libraryPrint?: (
    assignmentId: string,
  ) => Parameters<typeof receiveApiCommand>[0]['libraryPrint']
  /** Remembers what a library start printed so the finished job links to it (#385). */
  libraryLinks?: Parameters<typeof receiveApiCommand>[0]['libraryLinks']
  resinCapabilities?: Parameters<
    typeof receiveApiCommand
  >[0]['resinCapabilities']
  /** True while local storage is degraded: commands are refused with `storage`. */
  storageDegraded?: () => boolean
  /** Latest Kobra X accessory evidence from its status collection. */
  kobraXControlEvidenceFor?: (
    printerKey: string,
  ) => import('../kobra-x/control-support.ts').KobraXControlEvidence | undefined
  speedModesFor?: (
    printerKey: string,
  ) =>
    | readonly import('../../../farm-protocol/src/control-actions.ts').SpeedMode[]
    | undefined
  /** Durable bed-collection hold: OpenFarm starts wait for `confirm_collection`. */
  collection?: QueueCollectionJournal
  /** Transport seam for tests. Defaults to the authenticated pause client. */
  createClient?: (
    scope: PauseConnectorSignallingScope,
    options: ClientOptions,
  ) => PauseClient
}

/** Each opted-in assignment owns its relay, journal handle and signalling lifecycle. */
export async function runPauseControl(input: PauseControlInput): Promise<void> {
  const ids = input.config.pause?.control?.assignmentIds
  if (!ids?.length) throw new Error('Pause control is not enabled')
  const owner = new AbortController()
  const abort = () => owner.abort()
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) owner.abort()
  const controls = new Map<
    string,
    (id: string) => readonly ExtendedControlAction[]
  >()
  const macroParams = new Map<
    string,
    (id: string) => MacroParamMap | undefined
  >()
  const macros = new Map<
    string,
    (id: string) => readonly string[] | undefined
  >()
  const tasks = ids.map((assignmentId) =>
    runAssignmentControl(
      {
        ...input,
        signal: owner.signal,
        ...(input.onControls
          ? {
              onControls: (
                read: (id: string) => readonly ExtendedControlAction[],
              ) => {
                controls.set(assignmentId, read)
                input.onControls?.((id) => controls.get(id)?.(id) ?? [])
              },
            }
          : {}),
        ...(input.onMacroParams
          ? {
              onMacroParams: (
                read: (id: string) => MacroParamMap | undefined,
              ) => {
                macroParams.set(assignmentId, read)
                input.onMacroParams?.((id) => macroParams.get(id)?.(id))
              },
            }
          : {}),
        ...(input.onMacros
          ? {
              onMacros: (
                read: (id: string) => readonly string[] | undefined,
              ) => {
                macros.set(assignmentId, read)
                input.onMacros?.((id) => macros.get(id)?.(id))
              },
            }
          : {}),
      },
      assignmentId,
    ).catch((error: unknown) => {
      owner.abort()
      throw error
    }),
  )
  try {
    // Drain every assignment even when one fails: no journal or driver is
    // abandoned while a sibling shuts down.
    const results = await Promise.allSettled(tasks)
    for (const result of results)
      if (result.status === 'rejected') throw result.reason
  } finally {
    input.signal.removeEventListener('abort', abort)
  }
}

async function runAssignmentControl(
  input: PauseControlInput,
  assignmentId: string,
): Promise<void> {
  const { config, credential } = input
  const pause = config.pause
  if (!pause || !pause.control?.assignmentIds.includes(assignmentId))
    throw new Error('Pause control is not enabled')
  const printerBinding = config.bindingFor(assignmentId)
  if (!printerBinding)
    throw new Error('Pause control assignment is not provisioned locally')
  const issuers = await loadPauseIssuerKeys(pause)
  const trustedPath = join(input.dataDirectory, 'trusted-keys.json')
  const trustedKeys =
    input.trustedKeys ??
    (existsSync(trustedPath) ||
    readdirSync(input.dataDirectory).includes('trusted-keys.epoch')
      ? (
          await openTrustedKeyStore({
            path: trustedPath,
            farmId: credential.farm_id,
            issuers,
          })
        ).authority
      : undefined)
  if (input.signal.aborted) return
  const jti = classified('credential', () =>
    credentialLookupId(credential.device_token),
  )
  const journal = classified('journal', () =>
    openCommandJournal({
      // Separate handles retain the legacy durable store. Its assignment and
      // printer indexes preserve replay/busy safety across config upgrades.
      directory: join(input.dataDirectory, 'pause-journal'),
      clock: Date.now,
    }),
  )
  const clock = Object.freeze({
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now(),
  })
  /** Upload target of this assignment's locally provisioned printer. */
  const uploadTargetFor = (
    printerKey: string,
  ): FileUploadTarget | undefined => {
    const mapping = readPrinterBinding(printerBinding)
    if (!mapping || mapping.printer_key !== printerKey) return undefined
    const collection = config.collection
    if (collection.version === 3) {
      const bambu = collection.bambu.printers.find(
        (p) => p.printerKey === printerKey,
      )
      if (bambu)
        return {
          backend: 'bambu',
          host: bambu.host,
          serial: bambu.serial,
          port: bambu.ftpsPort,
          accessCode: readBambuCredentials(bambu).password,
          trust: {
            ...(bambu.caFile
              ? { caPem: readFileSync(bambu.caFile, 'utf8') }
              : {}),
            ...(bambu.pinSha256 ? { pinSha256: bambu.pinSha256 } : {}),
          },
        }
    }
    if ('printers' in collection) {
      const printer = collection.printers.find(
        (p) =>
          p.printerKey === printerKey && p.origin === mapping.moonraker_origin,
      )
      if (printer) {
        const selected = validateMoonrakerInput({
          assignment: printer,
          allowedOrigins: collection.allowedOrigins,
          limits: collection.limits,
        })
        const apiKey = moonrakerAuthHeaders(selected.origin, selected.limits)[
          'X-Api-Key'
        ]
        return {
          backend: 'moonraker',
          origin: selected.origin,
          ...(apiKey ? { apiKey } : {}),
        }
      }
    }
    return createFileTargets({
      config,
      assignmentId,
      dataDirectory: input.dataDirectory,
    }).fileTransfer.targetFor(printerKey)
  }
  let relay: ReturnType<typeof createPauseCommandRelay>
  const apiWork = new Set<Promise<unknown>>()
  let observation: ControlObservation | null = null
  try {
    const router = createPauseDriverRouter({
      allowedOrigins: [
        ...config.collection.allowedOrigins,
        ...(config.collection.version === 2
          ? config.collection.kobralink.allowedOrigins
          : []),
      ],
      limits: config.collection.limits,
      clock,
      kobraXControlEvidence(binding) {
        const mapping =
          binding === printerBinding ? readPrinterBinding(binding) : null
        return mapping
          ? input.kobraXControlEvidenceFor?.(mapping.printer_key)
          : undefined
      },
      gcodeConsole: (binding) =>
        binding === printerBinding &&
        pause.control?.consoleAssignmentIds?.includes(assignmentId) === true,
      observe(binding, next) {
        const accepted = relay.observe(binding, next)
        observation = accepted ? next : null
        return accepted
      },
    })
    // The browser path starts library prints with the same starter as the
    // API path (#386); the API path keeps the plain router and its own steps.
    const libraryPrint = input.libraryPrint?.(assignmentId)
    const collectionKey = (binding: PrinterBinding) =>
      binding === printerBinding
        ? readPrinterBinding(binding)?.printer_key
        : undefined
    const hold = <D extends typeof router>(driver: D, api = false): D =>
      input.collection
        ? withCollectionHold(driver, {
            journal: input.collection,
            printerKey: collectionKey,
            requireInitialClearance(binding) {
              const mapping = readPrinterBinding(binding)
              const collection = config.collection
              return (
                api &&
                binding === printerBinding &&
                !!mapping &&
                'printers' in collection &&
                collection.printers.some(
                  (printer) =>
                    printer.printerKey === mapping.printer_key &&
                    printer.origin === mapping.moonraker_origin,
                )
              )
            },
          })
        : driver
    // The same locally observed printer state supplies both advertised modes and the guard.
    const speedDriver = {
      ...router,
      speedModes(binding: PrinterBinding) {
        const mapping =
          binding === printerBinding ? readPrinterBinding(binding) : null
        return mapping ? input.speedModesFor?.(mapping.printer_key) : undefined
      },
    }
    const apiDriver = hold(speedDriver, true)
    const libraryDriver = withLibraryPrint(speedDriver, {
      starter: libraryPrint,
      targetFor(binding) {
        const mapping = readPrinterBinding(binding)
        if (binding !== printerBinding || !mapping) return undefined
        try {
          return uploadTargetFor(mapping.printer_key)
        } catch {
          return undefined
        }
      },
      remember(binding, link, sentAt) {
        const mapping = readPrinterBinding(binding)
        if (mapping)
          input.libraryLinks?.remember(mapping.printer_key, link, sentAt)
      },
    })
    const browserDriver = hold(libraryDriver)
    input.onMacroParams?.((id) => {
      const binding = config.bindingFor(id)
      return binding ? router.macroParams?.(binding) : undefined
    })
    input.onMacros?.((id) => {
      const binding = config.bindingFor(id)
      return binding ? router.macros?.(binding) : undefined
    })
    if (input.onControls) {
      const readControls = (id: string) => {
        const binding = config.bindingFor(id)
        return binding ? browserDriver.controls(binding) : []
      }
      input.onControls(readControls)
      try {
        await router.detect(printerBinding, input.signal)
      } catch {
        // Failed detection retains the driver's conservative capabilities.
      }
      input.onControls(readControls)
    }
    relay = createPauseCommandRelay({
      authority: {
        issuers,
        freshness: input.freshness,
        ...(trustedKeys ? { trustedKeys } : {}),
      },
      clock,
      journal,
      driver: browserDriver,
      ...(input.storageDegraded
        ? { storageDegraded: input.storageDegraded }
        : {}),
      bindingFor: (id) => (id === assignmentId ? printerBinding : undefined),
    })
    input.apiHandlers?.set(assignmentId, (frame, inbox) => {
      if (!trustedKeys) {
        refuseApiCommand(frame, inbox, 'unsupported')
        return
      }
      if (input.signal.aborted) {
        refuseApiCommand(frame, inbox, 'not-ready')
        return
      }
      if (apiWork.size >= 8) {
        refuseApiCommand(frame, inbox, 'printer-busy')
        return
      }
      let beforeWrite: ControlObservation | null = null
      const work = receiveApiCommand(
        {
          farmId: credential.farm_id,
          agentId: credential.agent_id,
          keys: trustedKeys,
          journal,
          clock,
          driver: apiDriver,
          ...(input.resinCapabilities
            ? { resinCapabilities: input.resinCapabilities }
            : {}),
          ...(libraryPrint ? { libraryPrint } : {}),
          ...(input.libraryLinks ? { libraryLinks: input.libraryLinks } : {}),
          jobFiles: {
            directory: join(input.dataDirectory, 'job-file-staging'),
            targetFor: uploadTargetFor,
          },
          printer: (id) => (id === assignmentId ? printerBinding : undefined),
          observe() {
            const now = clock.monotonicNow()
            const maxAge = PAUSE_POLICY_HARD_MAXIMUMS.freshStateMs
            if (
              !observation ||
              observation.receivedMono > now ||
              observation.readyObservedMono > observation.receivedMono ||
              observation.printStateObservedMono > observation.receivedMono ||
              now - observation.readyObservedMono > maxAge ||
              now - observation.printStateObservedMono > maxAge
            )
              return null
            beforeWrite = observation
            return observation
          },
          async confirmEffect({ action, args }, { binding, sentMono, signal }) {
            const before = beforeWrite
            if (!before) return false
            const after = await router.waitForPaused({
              action: action as ControlAction,
              args,
              binding,
              signal,
              after: {
                connectionGeneration: before.connectionGeneration,
                sequence: before.sequence,
                sentMono,
              },
            })
            const now = clock.monotonicNow()
            const maxAge = PAUSE_POLICY_HARD_MAXIMUMS.freshStateMs
            return (
              !!after &&
              after.ready &&
              after.assignmentId === before.assignmentId &&
              after.printerKey === before.printerKey &&
              after.connectionGeneration === before.connectionGeneration &&
              after.sequence > before.sequence &&
              after.receivedMono <= now &&
              after.receivedMono > sentMono &&
              after.printStateObservedMono > sentMono &&
              after.readyObservedMono <= after.receivedMono &&
              after.printStateObservedMono <= after.receivedMono &&
              now - after.readyObservedMono <= maxAge &&
              now - after.printStateObservedMono <= maxAge &&
              (after.effect === undefined ||
                now - after.effect.observedMono <= maxAge) &&
              controlEffectMatches(action, args, after, sentMono)
            )
          },
          ...(input.storageDegraded
            ? { storageDegraded: input.storageDegraded }
            : {}),
        },
        { ...frame },
        { ...inbox, signal: AbortSignal.any([input.signal, inbox.signal]) },
      ).catch(() => {})
      apiWork.add(work)
      void work.then(() => apiWork.delete(work))
    })
  } catch (error) {
    // Nothing reached the journal yet: release it before failing.
    input.onMacroParams?.(() => undefined)
    input.onMacros?.(() => undefined)
    input.onControls?.(() => [])
    closeCommandJournal(journal)
    throw error
  }
  const createClient =
    input.createClient ??
    ((scope, options) => new PauseConnectorSignallingClient(scope, options))
  function diagnostic(value: PauseControlDiagnostic) {
    try {
      input.onDiagnostic(value)
    } catch {
      // Diagnostics never change the command path.
    }
  }
  // File listing and upload ride the same admitted control peer, for the
  // locally provisioned printer of this control assignment only.
  const files: NonNullable<ClientOptions['files']> = {
    ...createFileTargets({
      config,
      assignmentId,
      dataDirectory: input.dataDirectory,
    }),
    getAdmittedHandle: (transportId) => relay.admittedHandle(transportId),
  }
  function admitted(result: Awaited<ReturnType<typeof relay.admitPeer>>) {
    diagnostic(
      result.ok
        ? { kind: 'pause-admitted' }
        : { kind: 'pause-denied', reason: result.reason },
    )
  }
  try {
    await runSignallingLifecycle({
      signal: input.signal,
      credentialExpiresAt: credential.expires_at,
      retryMinMs: RETRY_MIN_MS,
      retryMaxMs: RETRY_MAX_MS,
      createSession(onTerminal, onAdmitted, onServed) {
        const peerSignal = new AbortController()
        let transportId: string | undefined
        let ended = false
        const client: PauseClient = createClient(
          {
            url: pause.signalling.endpoint,
            bindAddress: config.rtc.bindAddress,
            origin: pause.signalling.origin,
            audience: pause.signalling.audience,
            credentialAudience: pause.signalling.credentialAudience,
            agentId: credential.agent_id,
            farmId: credential.farm_id,
            assignmentId,
            jti,
            token: credential.device_token,
            identity: input.identity,
          },
          {
            files,
            onInboxReady() {
              onAdmitted()
              diagnostic({ kind: 'pause-listening' })
            },
            onProofsReady(value) {
              if (transportId || ended) throw new Error('Unexpected proofs')
              transportId = value.binding.transport_id
              const opened = relay.openPeer({
                binding: value.binding,
                browserProofWire: value.browserProofWire,
                connectorProofWire: value.connectorProofWire,
                sendPhase: (message) => client.sendPhase(message),
                sendResult: (result) => client.sendResult(result),
                signal: peerSignal.signal,
              })
              if (!opened) throw new Error('Pause relay refused the peer')
            },
            onPhase(frame) {
              if (!transportId) return
              // A session is single-use: once the relay admits its verified
              // browser peer, it has served and its end is not a failure.
              const served = (
                result: Awaited<ReturnType<typeof relay.admitPeer>>,
              ) => {
                if (result.ok) onServed()
                admitted(result)
              }
              if (frame.t === 'control.capability')
                void relay
                  .admitPeer({ transportId, capabilityWire: frame.wire })
                  .then(served, () =>
                    diagnostic({ kind: 'pause-denied', reason: 'error' }),
                  )
              else if (frame.t === 'control.admission-proof')
                void relay
                  .admitPeer({ transportId, admissionProofWire: frame.wire })
                  .then(served, () =>
                    diagnostic({ kind: 'pause-denied', reason: 'error' }),
                  )
            },
            onData(frame) {
              if (frame.t !== 'control.command' || !transportId) return
              // One attempt only. The relay answers the peer; nothing retries.
              void relay.commandPeer({ transportId, wire: frame.wire }).then(
                (outcome) =>
                  diagnostic({
                    kind: 'pause-outcome',
                    outcome,
                    reason: relay.diagnostics().lastReason,
                  }),
                () =>
                  diagnostic({
                    kind: 'pause-outcome',
                    outcome: 'outcome-unknown',
                    reason: undefined,
                  }),
              )
            },
            onTerminal(reason) {
              ended = true
              try {
                peerSignal.abort()
                if (transportId) relay.closePeer(transportId)
                diagnostic({ kind: 'pause-terminal', reason: label(reason) })
              } finally {
                onTerminal()
              }
            },
          },
        )
        return {
          start: () => client.start(),
          close: (reason) => client.close(reason),
          dispose: (ms) => client.dispose(ms),
        }
      },
    })
  } finally {
    input.apiHandlers?.delete(assignmentId)
    input.onMacroParams?.(() => undefined)
    input.onMacros?.(() => undefined)
    input.onControls?.(() => [])
    relay.close()
    // A stalled driver close retains the journal; it is never force-closed.
    const stall = setTimeout(
      () =>
        diagnostic({
          kind: 'pause-close-stalled',
          waitedMs: PAUSE_CLOSE_STALL_MS,
        }),
      PAUSE_CLOSE_STALL_MS,
    )
    try {
      await Promise.all([relay.settled, ...apiWork])
    } finally {
      clearTimeout(stall)
    }
    closeCommandJournal(journal)
  }
}
