import { moonrakerOrigins } from '../config/moonraker.ts'
import type { PhotonResinSessions } from '../anycubic-resin/collection.ts'
import { createPhotonResinCameraSource } from '../anycubic-resin/camera.ts'
import {
  photonResinWriteQualified,
  type PhotonResinQualification,
} from '../anycubic-resin/qualification.ts'
import { MAX_HEARTBEAT_HEALTH_BYTES } from '@open3dfarmmanager/farm-protocol'
import { join, resolve } from 'node:path'
import {
  openQueueCollectionJournal,
  unavailableQueueCollectionJournal,
  type QueueCollectionJournal,
} from '../control/queue-collection-journal.ts'
import type { MacroParamMap } from '../moonraker/control-macros.ts'
import { createPrinterDetailSources } from './printer-detail-session.ts'
import { createSdcpVideo } from '../sdcp/video.ts'
import {
  discoveryBindings,
  pause,
  runBackgroundDiscovery,
} from './background-discovery.ts'
import {
  ApiResinReplay,
  decodeApiEnvelopeFrame,
  encodeApiEnvelopeResultFrame,
} from '../../../farm-protocol/src/api-envelope.ts'
import { encodeSignallingClientFrame } from '../../../farm-protocol/src/signalling-socket.ts'
import {
  CLIENT_WRITE_LIMIT,
  type SocketPort,
} from '../webrtc/signalling-client-channel.ts'
import { openApiJobLifecycle } from './api-job-lifecycle.ts'
import { createRuntimeLogger } from './log.ts'
import { openFilamentRunJournal } from '../control/filament-run-journal.ts'
import { createFilamentRunAccounting } from '../spoolman/filament-run.ts'
import {
  createActiveSpoolReader,
  createFilamentRunTracker,
  type FilamentRunTracker,
} from '../spoolman/filament-run-tracker.ts'
import { createActiveSpoolAssignmentStore } from '../spoolman/active-assignments.ts'
import { readSpoolmanAuthorization } from '../spoolman/credential.ts'
import { declareSnapmakerU1Printers } from '../moonraker/u1-tools.ts'
import { registerMoonrakerPendingDispatch } from '../moonraker/pending-dispatch.ts'
import type { Logger } from '../../../shared/src/log.ts'
import type { TrustedKeyAuthority } from '../auth/trusted-key-store.ts'
import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'
import { openLocalStatus } from '../status/local.ts'
import type { SpoolmanSnapshot } from './spoolman-provider.ts'
import { loadExistingIdentity } from '../identity/store.ts'
import { readCredentialEnvelope } from '../config/credential.ts'
import { readAgentRuntimeConfig } from '../config/runtime.ts'
import { openScopedTelemetryQueue } from './queue-scope.ts'
import type {
  Diagnostic as CollectionDiagnostic,
  MoonrakerCollectionRefresh,
} from './collect.ts'
import type { TelemetrySender } from '../cloud/drain.ts'
import type { RenewalDiagnostic } from '../cloud/credential-renewal.ts'
import { credentialLookupId } from '../config/signalling.ts'
import { connectorVersionMetadata } from '../status/version.ts'
import {
  createPrinterLinkHealth,
  startLinkHealthHeartbeat,
} from './link-health.ts'
import { createFarmSnapshotSource } from './farm-snapshot-provider.ts'
import { createLibraryJobLinks } from './library-job-links.ts'
import {
  createConnectorLibrary,
  createPrinterProfiles,
} from './library-print-wiring.ts'
import {
  readBambuPrinterBinding,
  readCrealityPrinterBinding,
  readFlashforgePrinterBinding,
  readPhrozenPrinterBinding,
  readSdcpPrinterBinding,
} from '../control/printer-binding.ts'
import {
  moonrakerAuthHeaders,
  moonrakerSession,
  moonrakerWebUiOrigin,
  validateMoonrakerInput,
} from '../config/moonraker.ts'
import { crealityWebUiOrigin } from '../config/creality.ts'
import { isLoopbackBindAddress } from '../config/rtc.ts'
import type {
  PauseControlDiagnostic,
  PauseFailureReason,
} from './pause-control.ts'
import { recordAuthorityStale } from './pause-authority-audit.ts'
import {
  probeRtcBackend,
  type RtcBackendStatus,
} from '../webrtc/rtc-backend.ts'
import {
  createOfflineAuthority,
  type OfflineAuthorityStaleReason,
} from '../auth/offline-authority.ts'

type AgentDiagnostic =
  | CollectionDiagnostic
  | { kind: 'rtc-bind-non-loopback'; address: string }
  | {
      kind: 'rtc-backend'
      backend: RtcBackendStatus['backend']
      mode: RtcBackendStatus['mode']
      reason?: NonNullable<RtcBackendStatus['reason']>
    }
  | RenewalDiagnostic
  | PauseControlDiagnostic
  | { kind: 'pause-authority-stale'; reason: OfflineAuthorityStaleReason }
  | { kind: 'pause-failed'; reason: PauseFailureReason }
  | { kind: 'pause-audit-failed' }
  | { kind: 'pause-authority-confirm-refused' }
  | { kind: 'credential-expired' }
  | {
      kind: 'filament-run'
      status: 'applied' | 'uncertain' | 'rejected' | 'unknown' | 'record-only'
      reason: string | null
    }
  | { kind: 'filament-run-failed' }
  | { kind: 'readonly-admitted' }
  | { kind: 'readonly-listening' }
  | { kind: 'readonly-terminal'; reason: string }
  | { kind: 'delivery'; status: 'delivered' | 'retained'; count: number }
  | { kind: 'drain-loss'; expired: number; capacity: number }
  | { kind: 'telemetry-entry-dropped' }
  | { kind: 'telemetry-batch-refused'; records: number; total: number }
  | { kind: 'storage-degraded'; lost: number }
  | { kind: 'storage-recovered'; lost: number }
  | {
      kind: 'agent-summary'
      delivered: number
      retries: number
      expired: number
      capacity: number
      credentialExpired: boolean
      storageLost: number
      refusedRecords: number
    }

let bootstrapped = false
function bootstrapNetworking() {
  if (bootstrapped) return
  process.env.WS_NO_BUFFER_UTIL = '1'
  process.env.WS_NO_UTF_8_VALIDATE = '1'
  bootstrapped = true
}
function untilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/**
 * Wall clock for the reads in this file (credential expiry, queue time, local
 * status, pause authority confirm, drain clock) and for credential readback
 * and renewal scheduling. Downstream modules such as pause-control,
 * authenticated-http-telemetry and signalling still use real time, so an
 * injected clock is for tests of this file's logic only. Production omits it
 * and uses Date.now and the renewal's real timer sleep.
 */
export type AgentClock = Readonly<{
  now(): number
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}>
const systemClock: AgentClock = { now: () => Date.now() }

type AgentInput = {
  trustedKeys?: TrustedKeyAuthority
  /** Test override only; the CLI never sets it. The shipped list is empty. */
  phrozenQualifiedWrites?: Parameters<
    typeof import('./pause-control.ts').runPauseControl
  >[0]['phrozenQualifiedWrites']
  resinCapabilities?: Parameters<
    typeof import('./pause-control.ts').runPauseControl
  >[0]['resinCapabilities']
  /** Test seam: the shipped resin write list is empty and only code adds one. */
  photonResinQualifiedWrites?: readonly PhotonResinQualification[]
  clock?: AgentClock
  /**
   * Test composition only: replaces the shipped SDCP video qualification list,
   * which is empty. The CLI, the runtime file and the wire cannot set it.
   */
  sdcpQualifiedVideo?: readonly import('../sdcp/models.ts').SdcpQualification[]
  statusPort?: number
  configPath: string
  credentialPath: string
  dataDirectory: string
  telemetryDirectory?: string
  signal: AbortSignal
  onInventory?: (value: SpoolmanSnapshot) => void
  onDiagnostic: (value: AgentDiagnostic) => void
}

/** Restarts the agent after each persisted, server-confirmed credential renewal. */
export async function runConnectorAgent(input: AgentInput): Promise<void> {
  const logger = createRuntimeLogger(input.dataDirectory)
  logger.info('start')
  try {
    while (
      (await runConnectorAgentOnce(input, logger)) &&
      !input.signal.aborted
    ) {
      // Every run re-reads identity, credential and config from disk.
    }
  } finally {
    logger.info('stop')
  }
}

/**
 * One scoped queue, one maintained authenticated sender, one serial drain loop.
 * Resolves true when a renewed credential was persisted and a restart is due.
 */
async function runConnectorAgentOnce(
  input: AgentInput,
  logger: Logger,
): Promise<boolean> {
  const startedAt = performance.now()
  const identity = loadExistingIdentity(input.dataDirectory)
  // Config scope only needs agent/farm, which an expired envelope still binds.
  const config = readAgentRuntimeConfig(
    input.configPath,
    readCredentialEnvelope(input.credentialPath, identity.fingerprint),
    { phrozenQualifiedWrites: input.phrozenQualifiedWrites },
  )
  // One startup line whenever the operator widened the ICE bind beyond loopback.
  if (!isLoopbackBindAddress(config.rtc.bindAddress))
    input.onDiagnostic({
      kind: 'rtc-bind-non-loopback',
      address: config.rtc.bindAddress,
    })
  const { readOrRecoverRuntimeCredential, createRenewalHttpTransport } =
    await import('../cloud/credential-renewal.ts')
  const renewalOrigin = new URL(config.telemetry.endpoint).origin
  const clock = input.clock ?? systemClock
  const credential = await readOrRecoverRuntimeCredential({
    now: () => clock.now(),
    credentialPath: input.credentialPath,
    identity,
    onDiagnostic: input.onDiagnostic,
    ...(config.renewal
      ? {
          recovery: {
            transport: createRenewalHttpTransport({
              origin: renewalOrigin,
              timeoutMs: config.renewal.timeoutMs,
            }),
            origin: renewalOrigin,
            audience: config.renewal.audience,
            signal: input.signal,
          },
        }
      : {}),
  })
  const lookupId = config.signalling
    ? credentialLookupId(credential.device_token)
    : undefined
  if (input.signal.aborted) return false
  bootstrapNetworking()
  const { createAuthenticatedTelemetrySender } =
    await import('../cloud/authenticated-http-telemetry.ts')
  const send = createAuthenticatedTelemetrySender({
    endpoint: config.telemetry.endpoint,
    audience: config.telemetry.audience,
    timeoutMs: config.telemetry.timeoutMs,
    token: credential.device_token,
    farmId: credential.farm_id,
    agentId: credential.agent_id,
    identity,
  })
  if (clock.now() >= credential.expires_at)
    throw new Error('Runtime credential expired before startup')
  if (input.signal.aborted) return false
  const queue = openScopedTelemetryQueue({
    dataDirectory: input.dataDirectory,
    ...(input.telemetryDirectory
      ? { telemetryDirectory: input.telemetryDirectory }
      : {}),
    config,
    credential,
    now: clock.now(),
  })
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let failure: { error: unknown } | undefined
  let renewed = false
  let diagnosticBudget = 1024
  const totals = {
    delivered: 0,
    retries: 0,
    expired: 0,
    capacity: 0,
    credentialExpired: false,
  }
  function diagnostic(value: AgentDiagnostic) {
    if (value.kind === 'drain-loss') {
      logger.warn('queue-loss', { ...value })
    } else if (value.kind === 'storage-degraded') {
      logger.warn('storage-degraded', { lost: value.lost })
    } else if (value.kind === 'telemetry-entry-dropped') {
      logger.warn('telemetry-entry-dropped')
    } else if (value.kind === 'telemetry-batch-refused') {
      logger.warn('telemetry-batch-refused', {
        records: value.records,
        total: value.total,
      })
    }
    if (value.kind === 'summary' || diagnosticBudget-- > 0)
      input.onDiagnostic(value)
  }
  function fail(error: unknown) {
    failure ??= { error }
    controller.abort()
  }
  const tasks: Promise<void>[] = []
  const refs = config.assignments.map((assignment) => ({
    assignmentId: assignment.assignment_id,
    agentId: assignment.agent_id,
    printerKey: assignment.printer_key,
  }))
  let localStatus: Awaited<ReturnType<typeof openLocalStatus>> | undefined
  let macroParamsFor:
    ((assignmentId: string) => MacroParamMap | undefined) | undefined
  let macrosFor:
    ((assignmentId: string) => readonly string[] | undefined) | undefined
  let controlsFor:
    ((assignmentId: string) => readonly ExtendedControlAction[]) | undefined
  let refreshControls: (() => void) | undefined
  const kobraXControlEvidence = new Map<
    string,
    import('../kobra-x/control-support.ts').KobraXControlEvidence
  >()
  const printerSpeedModes = new Map<
    string,
    NonNullable<
      import('../../../farm-protocol/src/state.ts').PrinterState['speedModes']
    >
  >()
  const photonResinSessions: PhotonResinSessions = new Map()
  // One state for the signed video command, the camera and the detail page.
  const sdcpVideo = createSdcpVideo({
    boards: config.camera?.cameras.flatMap(({ source }) =>
      'kind' in source && source.kind === 'sdcp-rtsp'
        ? [source.mainboardId]
        : [],
    ),
    qualified: input.sdcpQualifiedVideo,
  })
  const detailSources = createPrinterDetailSources(config, { sdcpVideo })
  // Library prints (#384): download from the server or read the local copy,
  // checked against what each printer itself reported. Never stops the agent.
  const printerProfiles = createPrinterProfiles()
  const jobLinks = createLibraryJobLinks()
  const moonrakerPrinters =
    'printers' in config.collection ? config.collection.printers : []
  const moonrakerCollectionRefresh = new Map<
    string,
    MoonrakerCollectionRefresh
  >(moonrakerPrinters.map(({ printerKey }) => [printerKey, {}]))
  // Bed-collection hold (durable): a run OpenFarm started is held when it
  // finishes until an operator confirms the plate is clear. An unreadable
  // journal refuses every OpenFarm start.
  let collection: QueueCollectionJournal
  try {
    collection = openQueueCollectionJournal(
      join(input.dataDirectory, 'queue-collection.json'),
      (printerKey) => {
        const refresh = moonrakerCollectionRefresh.get(printerKey)
        if (!refresh) return
        refresh.releasedAtMonoMs = performance.now()
        refresh.request?.()
      },
    )
  } catch (error) {
    logger.warn('queue-collection-unavailable', { error })
    collection = unavailableQueueCollectionJournal()
  }
  // Locally declared Snapmaker U1 printers get the U1 tool mapping and
  // command capability set; withdrawn when this run ends.
  const withdrawU1 = declareSnapmakerU1Printers(moonrakerPrinters)
  // A job already finished on connect is reported only when OpenFarm has a
  // pending dispatch on that printer; otherwise the history import owns it.
  const apiJobs = openApiJobLifecycle({
    path: resolve(
      input.dataDirectory,
      `api-jobs-${credential.farm_id}-${credential.agent_id}.json`,
    ),
    onError: (error) => logger.warn('api-job-journal', { error }),
  })
  const rememberedStarts = new Map<string, number>()
  const withdrawPendingDispatch = registerMoonrakerPendingDispatch(
    (printerKey) =>
      apiJobs.hasRunning(printerKey) ||
      rememberedStarts.has(printerKey) ||
      collection.read(printerKey).dispatchedAt !== undefined,
  )
  // Filament run accounting (#664): only with a configured Spoolman. Every
  // run this process watched finish is journaled once; debits are never
  // retried. An unreadable journal disables accounting, never collection.
  let filamentRuns: FilamentRunTracker | undefined
  const spoolman =
    'spoolman' in config.collection ? config.collection.spoolman : undefined
  if (spoolman)
    try {
      const journal = openFilamentRunJournal({
        path: join(input.dataDirectory, 'filament-runs.json'),
      })
      const authorization = readSpoolmanAuthorization(
        spoolman.credentialFile,
        spoolman.origin,
      )
      const accounting = createFilamentRunAccounting({
        journal,
        origin: spoolman.origin,
        ...(authorization ? { authorization } : {}),
      })
      const moonraker = new Map(
        moonrakerPrinters.map((printer) => {
          const selected = validateMoonrakerInput({
            assignment: printer,
            allowedOrigins: moonrakerOrigins(config.collection),
            limits: config.collection.limits,
          })
          return [
            selected.printerKey,
            {
              origin: selected.origin,
              async headers() {
                const session = moonrakerSession(
                  selected.origin,
                  selected.limits,
                )
                return session
                  ? await session.getAuthHeaders()
                  : moonrakerAuthHeaders(selected.origin, selected.limits)
              },
            },
          ] as const
        }),
      )
      filamentRuns = createFilamentRunTracker({
        accounting,
        readSpools: createActiveSpoolReader({
          moonraker,
          assignments: createActiveSpoolAssignmentStore(
            spoolman.assignmentsFile ??
              join(input.dataDirectory, 'active-spool-assignments.json'),
          ),
        }),
        signal,
        onOutcome(printerKey, outcomes) {
          for (const outcome of outcomes) {
            logger.info('filament-run', {
              printerKey,
              tool: outcome.tool,
              status: outcome.status,
              reason: outcome.reason,
              duplicate: outcome.duplicate,
            })
            if (outcome.status !== 'pending' && !outcome.duplicate)
              diagnostic({
                kind: 'filament-run',
                status: outcome.status,
                reason: outcome.reason,
              })
          }
        },
        onError(printerKey, error) {
          logger.warn('filament-run-failed', { printerKey, error })
          diagnostic({ kind: 'filament-run-failed' })
        },
      })
    } catch (error) {
      logger.warn('filament-run-unavailable', { error })
    }
  const libraryLinks = {
    remember(...args: Parameters<typeof jobLinks.remember>) {
      rememberedStarts.delete(args[0])
      rememberedStarts.set(args[0], args[2] ?? Date.now())
      while (rememberedStarts.size > 64)
        rememberedStarts.delete(rememberedStarts.keys().next().value!)
      jobLinks.remember(...args)
    },
    attach(printer: Parameters<typeof jobLinks.attach>[0]) {
      printerProfiles.observe(printer)
      try {
        filamentRuns?.observe(printer)
      } catch {
        // Accounting never stops collection.
      }
      if (
        printer.lastJob &&
        printer.state !== 'printing' &&
        printer.state !== 'paused'
      ) {
        // A previous job's repeated end never consumes a newer start.
        if (
          printer.lastJob.endedAt >=
          (rememberedStarts.get(printer.printerKey) ?? Infinity)
        )
          rememberedStarts.delete(printer.printerKey)
        try {
          collection.finished(printer.printerKey, printer.lastJob.endedAt)
        } catch {
          // The journal fails closed: starts are refused until it recovers.
        }
      }
      return jobLinks.attach(printer)
    },
  }
  const library = await createConnectorLibrary({
    endpoint: config.telemetry.endpoint,
    credential,
    identity,
    dataDirectory: input.dataDirectory,
    library: config.library,
  }).catch((error: unknown) => {
    logger.warn('library-print-unavailable', { error })
    return undefined
  })
  let snapshots: ReturnType<typeof createFarmSnapshotSource> | undefined
  let spoolMembership:
    | ReturnType<typeof import('./api-query.ts').createSpoolMembershipReader>
    | undefined
  try {
    // One startup probe of the native RTC module. Without it the agent keeps
    // collecting and reporting but offers no browser RTC session.
    const rtcBackend = await probeRtcBackend()
    diagnostic({
      kind: 'rtc-backend',
      backend: rtcBackend.backend,
      mode: rtcBackend.mode,
      ...(rtcBackend.reason ? { reason: rtcBackend.reason } : {}),
    })
    if (input.statusPort !== undefined) {
      localStatus = await openLocalStatus({
        port: input.statusPort,
        read: () => ({
          queueDepth: queue.depth,
          delivered: totals.delivered,
          retries: totals.retries,
          credentialExpired:
            totals.credentialExpired || clock.now() >= credential.expires_at,
          storageDegraded: queue.storageDegraded,
          storageLost: queue.storageLost,
          refusedRecords: queue.refusedRecords,
          rtc: rtcBackend,
        }),
        onError: fail,
      })
    }
    if (signal.aborted) return false
    const cameraMedia =
      config.camera &&
      config.signalling &&
      lookupId &&
      rtcBackend.mode === 'direct'
        ? await (
            await import('../camera/camera-runtime.ts')
          ).createCameraMediaFactory({
            config: config.camera,
            identity,
            agentId: credential.agent_id,
            farmId: credential.farm_id,
            assignmentRefs: refs,
            photonResin(assignmentId) {
              const key = refs.find(
                (ref) => ref.assignmentId === assignmentId,
              )?.printerKey
              const binding =
                config.collection.version === 8
                  ? config.collection.drivers.find(
                      (driver) => driver.printerKey === key,
                    )
                  : undefined
              if (binding?.family !== 'anycubic-resin')
                throw Error('Photon resin camera is not configured')
              return createPhotonResinCameraSource({
                host: new URL(binding.origin).hostname,
                port: binding.cameraPort ?? 18088,
                qualified: photonResinWriteQualified(
                  'camera',
                  binding.expect.model,
                  input.photonResinQualifiedWrites,
                ),
                session: () => photonResinSessions.get(binding.printerKey),
                onRefused: (reason) =>
                  logger.warn('photon-camera-refused', { reason }),
              })
            },
            sdcpVideo,
          })
        : undefined
    const links = new Map(
      config.collection.printers.map(({ printerKey }) => [
        printerKey,
        createPrinterLinkHealth(printerKey),
      ]),
    )
    const readHeartbeat = () =>
      ({
        connector: {
          version: connectorVersionMetadata.connectorVersion,
          uptimeMs: Math.floor(performance.now() - startedAt),
          queueBacklog: queue.depth,
          // Absent while zero, so a healthy heartbeat keeps its shape.
          ...(queue.refusedRecords
            ? { refusedRecords: queue.refusedRecords }
            : {}),
          storage: queue.storageDegraded ? 'degraded' : 'healthy',
          rtcScope:
            !lookupId || rtcBackend.mode !== 'direct'
              ? 'disabled'
              : isLoopbackBindAddress(config.rtc.bindAddress)
                ? 'loopback'
                : 'lan',
        },
        ...(cameraMedia
          ? { cameraAssignments: cameraMedia.assignmentIds }
          : {}),
        printers: Array.from(links.values(), (link) => link.read()),
      }) satisfies import('../../../farm-protocol/src/telemetry.ts').HeartbeatHealth
    const enqueueHeartbeat = (health: ReturnType<typeof readHeartbeat>) => {
      const printers = health.printers.slice(0, 100)
      while (
        Buffer.byteLength(JSON.stringify({ ...health, printers })) >
        MAX_HEARTBEAT_HEALTH_BYTES
      )
        printers.pop()
      const { loss } = queue.enqueueHeartbeat(
        { ...health, printers },
        clock.now(),
      )
      if (loss.expired || loss.capacity) logger.warn('queue-loss', { ...loss })
    }
    startLinkHealthHeartbeat(
      () => {
        const health = readHeartbeat()
        try {
          enqueueHeartbeat(health)
        } catch (error) {
          fail(error)
        }
        return health
      },
      (frames) => {
        for (const frame of frames)
          logger.info('link-health-heartbeat', JSON.parse(frame))
      },
      signal,
    )
    snapshots = config.signalling
      ? createFarmSnapshotSource({
          assignmentRefs: refs,
          linkHealthFor(printerKey) {
            const health = links.get(printerKey)
            if (!health) return
            const { printerKey: _printerKey, ...status } = health.read()
            return status
          },
          controlsFor: (id) => {
            const assignment = config.assignments.find(
              (item) => item.assignment_id === id,
            )
            if (
              assignment &&
              'backend' in assignment &&
              assignment.backend === 'prusa-link'
            )
              return []
            // An absent list would offer the legacy pause button.
            if (
              assignment &&
              'backend' in assignment &&
              assignment.backend === 'anycubic-resin'
            )
              return controlsFor?.(id) ?? []
            const ref = refs.find((item) => item.assignmentId === id)
            if (
              config.collection.version === 7 &&
              config.collection.formlabs.printers.some(
                (printer) => printer.printerKey === ref?.printerKey,
              )
            )
              return []
            // SDCP advertises controls only for a local control opt-in.
            const local = config.bindingFor(id)
            if (
              config.collection.version === 6 &&
              config.collection.sdcp.printers.some(
                (printer) => printer.printerKey === ref?.printerKey,
              ) &&
              !(local && readSdcpPrinterBinding(local))
            )
              return []
            return controlsFor?.(id)
          },
          // Only a Flashforge or Phrozen binding opted in to control
          // advertises any.
          readOnlyControlsFor: (id) => {
            const local = config.bindingFor(id)
            return local &&
              (readFlashforgePrinterBinding(local) ||
                readPhrozenPrinterBinding(local))
              ? controlsFor?.(id)
              : []
          },
          macrosFor: (id) => macrosFor?.(id),
          macroParamsFor: (id) => macroParamsFor?.(id),
          localWebUiOriginFor: (id) => {
            const assignment = config.assignments.find(
              (item) => item.assignment_id === id,
            )
            if (!assignment) return
            if ('moonraker_origin' in assignment && assignment.moonraker_origin)
              return moonrakerWebUiOrigin(assignment.moonraker_origin)
            const binding = config.bindingFor(id)
            if (!binding) return
            const bambu = readBambuPrinterBinding(binding)
            if (bambu) return `http://${bambu.host}`
            const creality = readCrealityPrinterBinding(binding)
            if (creality) return crealityWebUiOrigin(creality)
            return
          },
        })
      : undefined
    const { collectIntoQueue } = await import('./collect.ts')
    const { drainTelemetryOnce } = await import('../cloud/drain.ts')
    // Own budget: pause traffic never starves read-only diagnostics.
    let pauseBudget = 256
    const pauseDiagnostic = (value: AgentDiagnostic) => {
      if (pauseBudget-- <= 0) return
      if (value.kind === 'file-list-failed')
        logger.warn('file-list-failed', {
          reason: value.reason,
          requestSent: value.requestSent,
        })
      try {
        input.onDiagnostic(value)
      } catch {
        // A throwing sink never rejects the pause task or stops the agent.
      }
    }
    // Repeating faults bypass the pause budget but are reported once a minute.
    const rareAt = new Map<string, number>()
    const pauseRareDiagnostic = (value: AgentDiagnostic) => {
      const at = performance.now(),
        last = rareAt.get(value.kind)
      if (last !== undefined && at - last < 60_000) return
      rareAt.set(value.kind, at)
      try {
        input.onDiagnostic(value)
      } catch {
        // A throwing sink never rejects the pause task or stops the agent.
      }
    }
    // Offline authority for the pause path. Only the credential-authenticated
    // read-only inbox confirms it; without `signalling` it stays stale and
    // every pause command is rejected. Never stub it as fresh.
    const offline = config.pause?.control
      ? createOfflineAuthority({
          onStale(reason) {
            logger.warn('authority-stale', { reason })
            pauseDiagnostic({ kind: 'pause-authority-stale', reason })
            // The fsynced write runs on a later turn, never inside the caller's
            // freshness check or its microtask queue.
            setImmediate(() =>
              recordAuthorityStale(
                input.dataDirectory,
                reason,
                pauseRareDiagnostic,
              ),
            )
          },
        })
      : undefined
    const apiHandlers: NonNullable<
      Parameters<
        typeof import('./pause-control.ts').runPauseControl
      >[0]['apiHandlers']
    > = new Map()
    if (
      config.signalling &&
      lookupId &&
      snapshots &&
      rtcBackend.mode === 'direct'
    ) {
      const { AuthenticatedConnectorSignallingClient, connectorSocket } =
        await import('../cloud/authenticated-signalling-client.ts')
      const { FarmStatusSender } =
        await import('../webrtc/farm-status-sender.ts')
      const { runSignallingLifecycle } = await import('./signalling.ts')
      const {
        answerApiQuery,
        createApiQueryReader,
        createSpoolMembershipReader,
      } = await import('./api-query.ts')
      const signalling = config.signalling
      spoolMembership = createSpoolMembershipReader()
      const readApiQuery = createApiQueryReader(
        config,
        input.dataDirectory,
        collection,
        spoolMembership.read,
      )
      const source = snapshots
      const detailSourceFor = detailSources.sourceFor
      tasks.push(
        runSignallingLifecycle({
          signal,
          credentialExpiresAt: credential.expires_at,
          retryMinMs: signalling.retryMinMs,
          retryMaxMs: signalling.retryMaxMs,
          onReconnect: () => logger.info('reconnect'),
          createSession(onTerminal, onAdmitted) {
            const inbox = new AbortController()
            let pendingQueries = 0
            let socket: SocketPort | undefined
            let detachJobReports: (() => void) | undefined
            const closeInbox = () => {
              inbox.abort()
              detachJobReports?.()
            }
            const client = new AuthenticatedConnectorSignallingClient(
              {
                url: signalling.endpoint,
                bindAddress: config.rtc.bindAddress,
                origin: signalling.origin,
                audience: signalling.audience,
                agentId: credential.agent_id,
                farmId: credential.farm_id,
                jti: lookupId,
                token: credential.device_token,
                identity,
              },
              {
                genuineStatus: { assignmentRefs: refs, detailSourceFor },
                ...(cameraMedia ? { cameraMedia } : {}),
                async socketFactory() {
                  socket = await connectorSocket(
                    signalling.endpoint,
                    undefined,
                    true,
                  )
                  return socket
                },
                onInboxReady() {
                  // The command callback belongs to its original session.
                  // Reports reuse this admitted socket with one bounded write in flight.
                  if (inbox.signal.aborted || signal.aborted) return
                  detachJobReports = apiJobs.attach(
                    (wire) =>
                      new Promise<void>((resolve, reject) => {
                        const message = encodeSignallingClientFrame({
                          v: 1,
                          t: 'connector.api-result',
                          wire,
                        })
                        if (
                          signal.aborted ||
                          inbox.signal.aborted ||
                          !socket?.isOpen() ||
                          socket.bufferedBytes() + Buffer.byteLength(message) >
                            CLIENT_WRITE_LIMIT
                        ) {
                          reject(new Error('API job report inbox unavailable'))
                          if (!signal.aborted && !inbox.signal.aborted)
                            client.close('api-job-report-write')
                          return
                        }
                        socket.send(message, (error) => {
                          if (!error) resolve()
                          else {
                            reject(error)
                            if (!inbox.signal.aborted)
                              client.close('api-job-report-write')
                          }
                        })
                      }),
                  )
                  onAdmitted()
                  diagnostic({ kind: 'readonly-listening' })
                },
                // Callbacks must return nothing; a refused confirm stays stale.
                onAuthorityConfirm(serverSeq) {
                  if (offline) {
                    if (
                      offline.confirm(
                        { wall: clock.now(), mono: performance.now() },
                        serverSeq,
                      )
                    ) {
                      logger.info('authority-confirmed')
                    } else {
                      pauseRareDiagnostic({
                        kind: 'pause-authority-confirm-refused',
                      })
                    }
                  }
                },
                onApiQuery(frame, report) {
                  if (inbox.signal.aborted || pendingQueries >= 4) return
                  pendingQueries++
                  const querySignal = AbortSignal.any([
                    inbox.signal,
                    signal,
                    AbortSignal.timeout(8000),
                  ])
                  void answerApiQuery(frame, readApiQuery, querySignal)
                    .then((reply) => {
                      if (!inbox.signal.aborted && !signal.aborted)
                        report(reply)
                    })
                    .catch(() => {})
                    .finally(() => {
                      pendingQueries--
                    })
                },
                onApiCommand(frame, report) {
                  if (inbox.signal.aborted) return
                  const { envelope } = decodeApiEnvelopeFrame(frame.wire)
                  const assignedHandler = apiHandlers.get(
                    envelope.assignment_id,
                  )
                  if (
                    !assignedHandler &&
                    ApiResinReplay.safeParse(envelope.action).success
                  ) {
                    // This inbox is credential-authenticated. An assignment
                    // without a control handler can only report a refusal.
                    if (
                      envelope.farm_id === credential.farm_id &&
                      envelope.agent_id === credential.agent_id &&
                      refs.some(
                        (ref) => ref.assignmentId === envelope.assignment_id,
                      )
                    )
                      report(
                        encodeApiEnvelopeResultFrame({
                          v: 1,
                          t: 'api-envelope.result',
                          cmd_id: envelope.cmd_id,
                          outcome: 'refused',
                          refusal_code: 'unsupported',
                          detail: 'resin-artifact-dispatch-unavailable',
                          at: clock.now(),
                        }),
                      )
                    return
                  }
                  if (!offline) return
                  const handler =
                    assignedHandler ?? apiHandlers.values().next().value
                  handler?.(frame, {
                    report,
                    apiJobs,
                    signal: inbox.signal,
                    freshness: offline.freshness,
                  })
                },
                onAuthorityRevoked(serverSeq) {
                  closeInbox()
                  offline?.revoke(serverSeq)
                },
                onVerifiedAdmission: () =>
                  diagnostic({ kind: 'readonly-admitted' }),
                onTerminal(reason) {
                  closeInbox()
                  try {
                    diagnostic({
                      kind: 'readonly-terminal',
                      reason: /^[a-zA-Z0-9:_-]{1,80}$/.test(reason)
                        ? reason
                        : 'unclassified',
                    })
                  } finally {
                    onTerminal()
                  }
                },
              },
            )
            let sender: InstanceType<typeof FarmStatusSender>
            try {
              sender = new FarmStatusSender({
                bindAddress: config.rtc.bindAddress,
                client,
                assignmentRefs: refs,
                openSnapshots: source.open,
                signal,
                storageDegraded: () => queue.storageDegraded,
              })
            } catch (error) {
              client.close('runtime-setup-failed')
              // Preserve the cleanup promise in the lifecycle's owned session.
              return {
                start: () => Promise.reject(error),
                close: () => client.close(),
                dispose: (ms) => client.dispose(ms),
              }
            }
            return {
              start: () => sender.start(),
              close: (reason) => sender.close(reason),
              dispose: (ms) => client.dispose(ms),
            }
          },
        }).catch(fail),
      )
    }
    // Credential renewal: a persisted, server-confirmed successor restarts the
    // agent so every sender re-reads the credential file (see end of function).
    if (config.renewal) {
      const { runCredentialRenewal, createRenewalHttpTransport } =
        await import('../cloud/credential-renewal.ts')
      const sleep = clock.sleep
      const renewalSleep = sleep
        ? (ms: number, s: AbortSignal) => sleep.call(clock, ms, s)
        : undefined
      const origin = new URL(config.telemetry.endpoint).origin
      tasks.push(
        runCredentialRenewal({
          credentialPath: input.credentialPath,
          credential,
          identity,
          transport: createRenewalHttpTransport({
            origin,
            timeoutMs: config.renewal.timeoutMs,
          }),
          origin,
          audience: config.renewal.audience,
          retryMinMs: config.renewal.retryMinMs,
          retryMaxMs: config.renewal.retryMaxMs,
          now: () => clock.now(),
          ...(renewalSleep ? { sleep: renewalSleep } : {}),
          signal,
          onDiagnostic: diagnostic,
          onRenewed() {
            renewed = true
            controller.abort()
          },
        }).catch(fail),
      )
    }
    if (offline) {
      // Explicit opt-in only. Absent `pause.control` creates no pause resource.
      const { runPauseControl, pauseFailureReason } =
        await import('./pause-control.ts')
      tasks.push(
        runPauseControl({
          config,
          credential,
          identity,
          dataDirectory: input.dataDirectory,
          signal,
          freshness: offline.freshness,
          sdcpVideo,
          apiHandlers,
          libraryLinks,
          collection,
          speedModesFor(printerKey) {
            return printerSpeedModes.get(printerKey)
          },
          kobraXControlEvidenceFor: (printerKey) =>
            kobraXControlEvidence.get(printerKey),
          photonResinSessions,
          ...(input.photonResinQualifiedWrites
            ? { photonResinQualifiedWrites: input.photonResinQualifiedWrites }
            : {}),
          libraryPrint(assignmentId) {
            const key = refs.find(
              (ref) => ref.assignmentId === assignmentId,
            )?.printerKey
            return library?.starterFor(async () =>
              key ? printerProfiles.read(key) : undefined,
            )
          },
          ...(input.trustedKeys ? { trustedKeys: input.trustedKeys } : {}),
          phrozenQualifiedWrites: input.phrozenQualifiedWrites,
          ...(input.resinCapabilities
            ? { resinCapabilities: input.resinCapabilities }
            : {}),
          storageDegraded: () => queue.storageDegraded,
          onDiagnostic: pauseDiagnostic,
          onMacroParams(read) {
            macroParamsFor = read
          },
          onMacros(read) {
            macrosFor = read
          },
          onControls(read) {
            controlsFor = read
            refreshControls?.()
          },
        }).catch((error: unknown) => {
          // A pause-path failure never stops read-only telemetry or status.
          pauseDiagnostic({
            kind: 'pause-failed',
            reason: pauseFailureReason(error),
          })
        }),
      )
    }
    async function drainLoop() {
      let backoff = config.telemetry.retryMinMs
      let notBefore = 0
      let storageReported = false
      let storageBackoff = config.telemetry.retryMinMs
      while (!signal.aborted) {
        // Degraded storage: collection, RTC status and local status keep
        // running; uploads wait for a bounded, backed-off storage retry.
        if (queue.storageDegraded) {
          if (!storageReported) {
            storageReported = true
            diagnostic({ kind: 'storage-degraded', lost: queue.storageLost })
          }
          await pause(storageBackoff, signal)
          if (signal.aborted) return
          storageBackoff = Math.min(
            config.telemetry.retryMaxMs,
            storageBackoff * 2,
          )
          if (queue.retryStorage()) {
            storageReported = false
            storageBackoff = config.telemetry.retryMinMs
            diagnostic({ kind: 'storage-recovered', lost: queue.storageLost })
          }
          continue
        }
        if (clock.now() >= credential.expires_at) {
          totals.credentialExpired = true
          diagnostic({ kind: 'credential-expired' })
          await untilAbort(signal)
          return
        }
        const wait = notBefore - performance.now()
        if (wait > 0) {
          await pause(
            Math.min(wait, credential.expires_at - clock.now()),
            signal,
          )
          continue
        }
        const attempt = new AbortController()
        const attemptSignal = AbortSignal.any([signal, attempt.signal])
        const timer = setTimeout(
          () => attempt.abort(),
          Math.max(
            1,
            Math.min(
              config.telemetry.timeoutMs,
              credential.expires_at - clock.now(),
            ),
          ),
        )
        let settlement: Promise<unknown> | undefined
        const tracked: TelemetrySender = (body, requestSignal) => {
          if (settlement)
            throw new Error('Overlapping authenticated sender invocation')
          settlement = send(body, requestSignal)
          return settlement
        }
        let result
        try {
          result = await drainTelemetryOnce(
            queue,
            tracked,
            () => clock.now(),
            attemptSignal,
            () => diagnostic({ kind: 'telemetry-entry-dropped' }),
            (records) => {
              diagnostic({
                kind: 'telemetry-batch-refused',
                records,
                total: queue.refusedRecords,
              })
            },
          )
        } finally {
          // Drain may return cancelled before its sender releases the active slot.
          if (settlement) await settlement.catch(() => {})
          clearTimeout(timer)
          attempt.abort()
        }
        if (result.loss) {
          totals.expired += result.loss.expired
          totals.capacity += result.loss.capacity
          if (result.loss.expired || result.loss.capacity)
            diagnostic({
              kind: 'drain-loss',
              expired: result.loss.expired,
              capacity: result.loss.capacity,
            })
        }
        if (result.status === 'delivered') totals.delivered += result.count
        // A storage fault during this attempt is handled at the top of the loop.
        if (queue.storageDegraded || result.status === 'dropped') continue
        if (
          result.status === 'uncertain' ||
          (result.status === 'retained' && result.reason === 'busy')
        )
          throw new Error('Telemetry drain requires operator review')
        if (signal.aborted) return
        if (result.status === 'refused') {
          // The refused batch is gone; newer records are due at once.
          backoff = config.telemetry.retryMinMs
          notBefore = 0
        } else if (result.status === 'delivered') {
          diagnostic({
            kind: 'delivery',
            status: 'delivered',
            count: result.count,
          })
          backoff = config.telemetry.retryMinMs
          notBefore = 0
        } else if (result.status === 'empty') {
          await pause(config.telemetry.idleMs, signal)
        } else {
          totals.retries++
          diagnostic({ kind: 'delivery', status: 'retained', count: 0 })
          const jittered =
            config.telemetry.retryMinMs +
            Math.floor(
              Math.random() * (backoff - config.telemetry.retryMinMs + 1),
            )
          notBefore = performance.now() + jittered
          backoff = Math.min(config.telemetry.retryMaxMs, backoff * 2)
        }
      }
    }
    tasks.push(
      collectIntoQueue({
        config: config.collection,
        photonResin: {
          sessions: photonResinSessions,
          onCapabilitiesChange: () => refreshControls?.(),
        },
        ...(config.kobraX
          ? {
              kobraX: {
                bindings: config.kobraX,
                onControlEvidence(printerKey, evidence) {
                  if (evidence) kobraXControlEvidence.set(printerKey, evidence)
                  else kobraXControlEvidence.delete(printerKey)
                  refreshControls?.()
                },
              },
            }
          : {}),
        apiJobs,
        onPrinterState(printer) {
          if (printer.speedModes === undefined)
            printerSpeedModes.delete(printer.printerKey)
          else
            printerSpeedModes.set(printer.printerKey, [...printer.speedModes])
        },
        controlsFor: (printerKey) => {
          const ref = refs.find((entry) => entry.printerKey === printerKey)
          return ref ? controlsFor?.(ref.assignmentId) : undefined
        },
        onControlsRefresh(refresh) {
          refreshControls = refresh
          refresh()
        },
        moonrakerCollectionRefresh,
        linkHealthFor: (printerKey) => links.get(printerKey),
        libraryLinks,
        discoverMoonrakerObjects: true,
        importMoonrakerHistory: true,
        onLoss: (value) => logger.warn('queue-loss', { ...value }),
        ...(input.onInventory || snapshots
          ? {
              onInventory(value: SpoolmanSnapshot) {
                spoolMembership?.update(value)
                snapshots?.setInventory(value)
                input.onInventory?.(value)
              },
            }
          : {}),
        queue,
        signal,
        onDiagnostic: diagnostic,
        ...(snapshots
          ? {
              onRawObservation: (observation) => {
                if (!snapshots) return
                snapshots.observe(observation)
                detailSources.observe(observation.printer)
              },
              onRawUnavailable: (event) => {
                if (!snapshots) return
                snapshots.invalidate(event)
                detailSources.invalidate(event.printerKey)
              },
            }
          : {}),
      }).catch(fail),
    )
    tasks.push(
      runBackgroundDiscovery({
        ...config.discovery,
        signal,
        bindings: discoveryBindings(config.collection),
        now: () => clock.now(),
        report(results, now) {
          const { loss } = queue.enqueueDiscovery(results, now)
          if (loss.expired || loss.capacity)
            logger.warn('queue-loss', { ...loss })
        },
      }).catch(fail),
    )
    // Connector library storage (#446): answers the server's relay operations
    // on this host's store. A failure here never stops telemetry.
    if (library)
      tasks.push(
        library
          .serveRelay(signal, (event) =>
            logger.warn(event.kind, { reason: event.reason }),
          )
          .catch((error: unknown) =>
            logger.warn('library-relay-stopped', { error }),
          ),
      )
    tasks.push(drainLoop().catch(fail))
    await Promise.all(tasks)
  } catch (error) {
    fail(error)
  } finally {
    controller.abort()
    try {
      await localStatus?.close()
    } catch (error) {
      fail(error)
    }
    snapshots?.close()
    await Promise.all(tasks)
    await filamentRuns?.idle()
    withdrawU1()
    withdrawPendingDispatch()
    try {
      queue.close()
    } catch (error) {
      fail(error)
    }
    try {
      input.onDiagnostic({
        kind: 'agent-summary',
        ...totals,
        storageLost: queue.storageLost,
        refusedRecords: queue.refusedRecords,
      })
    } catch (error) {
      fail(error)
    }
  }
  if (failure) throw failure.error
  return renewed
}
