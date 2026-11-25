import { DriverRefusalError } from '../control/driver-refusal.ts'
import { toolTemperatureRefusal } from '../control/control-driver.ts'
import type { ToolHeaters } from '../../../farm-protocol/src/state.ts'
import { createHash } from 'node:crypto'
import { RESIN_LIBRARY_START_MESSAGE } from '../sdcp/models.ts'
import { resinArtifactFormatFor } from '../../../shared/src/print-file/resin-artifacts.ts'
import {
  preflightResinArtifactReplay,
  type ResinArtifactDispatchCapability,
} from '../../../shared/src/print-file/resin-replay.ts'
import type { z } from 'zod'
import {
  API_ENVELOPE_ISSUER,
  ApiRunAction,
  ApiPlateAction,
  ApiResinReplay,
  API_RUN_CONTROLS,
  isApiEnvironmentAction,
  scopeForApiCommand,
  decodeApiEnvelopeFrame,
  encodeApiEnvelopeResultFrame,
  ApiRefusalMessage,
  verifyApiEnvelope,
  type ApiEnvelopeRefusalCode,
  type ApiEnvelopeV1,
  type ApiEnvironmentAction,
} from '../../../farm-protocol/src/api-envelope.ts'
import {
  speedModeAllowed,
  controlPrinterBusy,
  controlSourceState,
  LibraryPrintArgs,
  U1_CONTROL_RESULT_TIMEOUT_MS,
  type ControlArguments,
} from '../../../farm-protocol/src/control-actions.ts'
import { macroParamsAllowed } from '../moonraker/control-macros.ts'
import type { SignallingServerFrame } from '../../../farm-protocol/src/signalling-socket.ts'
import {
  createOfflineAuthority,
  OFFLINE_AUTHORITY_MAX_SKEW_MS,
  type AuthoritySample,
  type CachedAuthorityFreshness,
} from '../auth/offline-authority.ts'
import type { TrustedKeyAuthority } from '../auth/trusted-key-store.ts'
import {
  claimApiCommand,
  finishCommand,
  markWriteStarted,
  type CommandClaimHandle,
  type CommandJournalHandle,
} from '../control/command-journal.ts'
import type { PlateStartGuard } from '../control/queue-collection-hold.ts'
import type { PreparedPauseDriver } from '../control/pause-dispatcher.ts'
import {
  readPrinterBinding,
  readSdcpPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import { controlWithinLimits, type ControlLimits } from './control-limits.ts'
import { fetchJobFile, JobFileError } from './job-file-fetch.ts'
import { supportsFileUpload, type FileUploadTarget } from './file-upload.ts'
import type { createLibraryPrintStarter } from './library-print-start.ts'
import type { ApiJobLifecycle, ApiRunEvidence } from './api-job-lifecycle.ts'
import type { LibraryJobLinks } from './library-job-links.ts'

/** A grant as last confirmed by the server; `freshness` bounds how long it is trusted offline. */
export type ApiGrant = Readonly<{
  grant_id: string
  app_id: string
  farm_id: string
  scopes: readonly string[]
  revoked: boolean
}>
export type ApiPrinterObservation = Readonly<{
  ready: boolean
  printState: string
  toolHeaters?: readonly ToolHeaters[number][] | undefined
}>
export type ApiCommandDriver = Pick<
  PreparedPauseDriver,
  | 'execute'
  | 'controls'
  | 'startUnavailableMessage'
  | 'macros'
  | 'macroParams'
  | 'speedModes'
  | 'allowsExtendedResult'
> &
  Partial<Pick<PreparedPauseDriver, 'closeAttempt'>> & {
    prepare?(
      input: Parameters<PreparedPauseDriver['prepare']>[0] & {
        observeRun?: (evidence: ApiRunEvidence) => void
      },
    ): ReturnType<PreparedPauseDriver['prepare']>
  } & PlateStartGuard
export interface QualifiedResinDispatch extends ResinArtifactDispatchCapability {
  /** Check vendor bytes, embedded profile and firmware compatibility locally. */
  validate(input: {
    filename: string
    path: string
    signal: AbortSignal
  }): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Call beforeSend immediately before the sole physical start. Return true only after positive start confirmation. */
  dispatch(input: {
    filename: string
    path: string
    binding: PrinterBinding
    signal: AbortSignal
    beforeSend(): boolean
    /** SDCP uploaders call this with no arguments after uploading the validated artifact. */
    startVerifiedSdcp?(): Promise<boolean>
  }): Promise<boolean>
}

type DriverRequest = z.infer<typeof ControlArguments>

/**
 * The qualified driver request behind an environment control, or undefined
 * when the Connector has no qualified capability for it. Extraction is the
 * chamber fan (`set_fan`), journalled like any API action. Smart plugs and
 * drying programs have no qualified API path yet (no journalled API action
 * and no qualified drying driver), so they are refused as unsupported.
 */
export function environmentDriverRequest(
  action: ApiEnvironmentAction,
): DriverRequest | undefined {
  if (action.action === 'extraction_set')
    return {
      action: 'set_fan',
      args: { fan: 'chamber', percent: action.args.percent },
    }
  return undefined
}

function driverAction(envelope: ApiEnvelopeV1): DriverRequest | undefined {
  const scoped = ApiRunAction.safeParse(envelope.action)
  if (scoped.success)
    return { action: API_RUN_CONTROLS[scoped.data.action], args: {} }
  if (isApiEnvironmentAction(envelope.action))
    return environmentDriverRequest(envelope.action)
  return envelope.action as DriverRequest | undefined
}

const ACTIVE_PRINT_STATES: readonly string[] = ['printing', 'paused']

/**
 * Safety interlocks for environment controls, decided from the Connector's
 * own observation; an unknown state refuses, it never allows. A smart plug is
 * never switched while a print runs or is paused, and extraction is never
 * turned off during one.
 */
export function environmentInterlock(
  action: ApiEnvironmentAction,
  observed: ApiPrinterObservation | null,
): [ApiEnvelopeRefusalCode, string] | null {
  if (
    !observed ||
    !observed.ready ||
    observed.printState === 'unknown' ||
    observed.printState === 'error'
  )
    return ['not-ready', 'environment-interlock-state-unknown']
  const active = ACTIVE_PRINT_STATES.includes(observed.printState)
  if (action.action === 'plug_switch' && active)
    return ['printer-busy', 'plug-interlock-print-active']
  if (action.action === 'extraction_set' && action.args.percent === 0 && active)
    return ['printer-busy', 'extraction-interlock-print-active']
  return null
}

export type ApiCommandResult =
  /** Unauthenticated, not ours, or a replay: nothing is reported. */
  | {
      kind: 'dropped'
      reason: 'invalid' | 'invalid-issuer' | 'replay'
    }
  | { kind: 'refused'; code: ApiEnvelopeRefusalCode; detail?: string }
  | { kind: 'completed' }
  /** The send may have happened; nothing is reported and nothing is retried. */
  | { kind: 'outcome-unknown' }

const MAX_EXECUTE_MS = 5000

/** The scope a grant must hold for this envelope; mirrors the server's issue check. */
export function apiEnvelopeScope(envelope: ApiEnvelopeV1): string {
  if (envelope.kind === 'job') return 'jobs:start'
  return scopeForApiCommand(envelope.action!.action)
}

/**
 * Runs API envelopes received over the credential inbox. Order: issuer
 * signature and identity, expiry, grant (revocation, offline freshness, scope),
 * replay and exclusion through the shared command journal, then the local
 * safety checks and exactly one driver send. Nothing is retried.
 */
export function createApiCommandRunner(config: {
  farmId: string
  agentId: string
  keys: Pick<TrustedKeyAuthority, 'issuer'>
  grants: {
    lookup(grantId: string): ApiGrant | undefined
    freshness: CachedAuthorityFreshness
  }
  journal: CommandJournalHandle
  printer(assignmentId: string): PrinterBinding | undefined
  /** Returns the latest fresh local observation, or null when unavailable or stale. */
  observe(binding: PrinterBinding): ApiPrinterObservation | null
  driver: ApiCommandDriver
  /** Sends one encoded `api-envelope.result` frame over the inbox. */
  report(wire: string): void
  clock: { wallNow(): number; monotonicNow(): number }
  controlLimits?: ControlLimits
  confirmEffect?: (
    action: DriverRequest,
    input: { binding: PrinterBinding; sentMono: number; signal: AbortSignal },
  ) => Promise<boolean>
  storageDegraded?: () => boolean
  signal?: AbortSignal
  apiJobs?: ApiJobLifecycle | undefined
  jobFiles?: {
    directory: string
    targetFor(printerKey: string): FileUploadTarget | undefined
    ca?: string | Buffer
  }
  /** Library print starts; without it `start_library_print` is refused as unsupported. */
  libraryPrint?: Pick<ReturnType<typeof createLibraryPrintStarter>, 'start'> &
    Partial<
      Pick<ReturnType<typeof createLibraryPrintStarter>, 'withVerifiedArtifact'>
    >
  resinCapabilities?(binding: PrinterBinding): readonly QualifiedResinDispatch[]
  /** Remembers what a library start printed so the finished job links to it (#385). */
  libraryLinks?: Pick<LibraryJobLinks, 'remember'>
}) {
  const sample = (): AuthoritySample => ({
    wall: config.clock.wallNow(),
    mono: config.clock.monotonicNow(),
  })
  function send(
    envelope: ApiEnvelopeV1,
    outcome: 'refused' | 'completed' | 'started',
    code?: ApiEnvelopeRefusalCode,
    detail?: string,
    message?: string,
  ) {
    try {
      config.report(
        encodeApiEnvelopeResultFrame({
          v: 1,
          t: 'api-envelope.result',
          cmd_id: envelope.cmd_id,
          outcome,
          ...(code ? { refusal_code: code } : {}),
          ...(detail ? { detail } : {}),
          // Invalid text is left out; it never costs the refusal itself.
          ...(ApiRefusalMessage.safeParse(message).success ? { message } : {}),
          at: config.clock.wallNow(),
        }),
      )
    } catch {
      /* Reporting never changes what was executed; the server sweeps unconfirmed commands. */
    }
  }
  function refuse(
    envelope: ApiEnvelopeV1,
    code: ApiEnvelopeRefusalCode,
    detail?: string,
    message?: string,
  ): ApiCommandResult {
    send(envelope, 'refused', code, detail, message)
    return detail
      ? { kind: 'refused', code, detail }
      : { kind: 'refused', code }
  }
  /** Grant, scope and expiry; rechecked right before the send. */
  function authorityRefusal(
    envelope: ApiEnvelopeV1,
    now: AuthoritySample,
  ): [ApiEnvelopeRefusalCode, string] | null {
    if (config.signal?.aborted)
      return ['grant-revoked', 'inbox authority ended']
    if (now.wall >= envelope.expires_at) return ['expired', 'envelope expired']
    if (
      envelope.scope !== undefined &&
      envelope.scope !== apiEnvelopeScope(envelope)
    )
      return ['grant-revoked', 'action outside the signed scope']
    const grant = config.grants.lookup(envelope.grant_id)
    if (
      !grant ||
      grant.revoked ||
      grant.grant_id !== envelope.grant_id ||
      grant.app_id !== envelope.app_id ||
      grant.farm_id !== envelope.farm_id
    )
      return ['grant-revoked', 'grant revoked']
    if (!config.grants.freshness.freshAt(now))
      return ['grant-revoked', 'grant not confirmed recently']
    if (
      !grant.scopes.includes(apiEnvelopeScope(envelope)) ||
      (ApiResinReplay.safeParse(envelope.action).success &&
        !grant.scopes.includes('jobs:start'))
    )
      return ['grant-revoked', 'action outside the granted scope']
    return null
  }
  function jobTarget(binding: PrinterBinding): FileUploadTarget | undefined {
    const mapping = readPrinterBinding(binding)
    if (!mapping) return undefined
    try {
      return config.jobFiles?.targetFor(mapping.printer_key)
    } catch {
      return undefined
    }
  }
  function safetyRefusal(
    envelope: ApiEnvelopeV1,
    binding: PrinterBinding,
  ): [ApiEnvelopeRefusalCode, string] | null {
    if (envelope.kind === 'job') {
      const target = jobTarget(binding)
      const advertised = config.driver.controls?.(binding) ?? []
      // A held start is still this printer's start. The state check names the hold.
      const heldForCollection =
        config.driver.plateStartRefusal?.(binding) === 'awaiting-collection'
      if (envelope.job && resinArtifactFormatFor(envelope.job.display_name))
        return ['unsupported', 'resin-artifact-requires-library-version']
      if (
        !target ||
        !envelope.job ||
        !supportsFileUpload(target, envelope.job.display_name) ||
        !config.driver.execute ||
        (!advertised.includes('start_print') && !heldForCollection)
      )
        return ['unsupported', 'job delivery is not supported by this printer']
      return null
    }
    const { action, args } = driverAction(envelope)!
    if (action === 'confirm_collection')
      return config.driver.apiCollectionRefusal &&
        config.driver.confirmApiCollection
        ? null
        : ['unsupported', 'plate confirmation is not supported by this printer']
    const resin = ApiResinReplay.safeParse(envelope.action)
    if (resin.success) {
      if (
        readSdcpPrinterBinding(binding) &&
        (!config.driver.execute ||
          !config.driver.controls?.(binding).includes('start_print'))
      )
        return ['unsupported', 'action not supported by this printer']
      const decision = resinPreflight(envelope, binding, resin.data.args)
      if (decision.status === 'rejected')
        return ['unsupported', decision.reason]
      if (
        decision.status === 'unsupported' ||
        !config.libraryPrint?.withVerifiedArtifact
      )
        return ['unsupported', 'resin-artifact-dispatch-unavailable']
      return null
    }
    if (action === 'set_speed') {
      const modes = config.driver.speedModes?.(binding)
      if (!speedModeAllowed(modes, args.level))
        return ['unsupported', 'speed mode not supported by this printer']
    }
    // A library start runs the driver's ordinary `start_print` after the file is in place.
    const libraryStart = action === 'start_library_print'
    const advertised = config.driver.controls?.(binding) ?? []
    const heldForCollection =
      (action === 'start_print' || libraryStart) &&
      config.driver.plateStartRefusal?.(binding) === 'awaiting-collection'
    if (
      !config.driver.execute ||
      (libraryStart && (!config.libraryPrint || !jobTarget(binding))) ||
      (!advertised.includes(libraryStart ? 'start_print' : action) &&
        !heldForCollection) ||
      !controlWithinLimits(action, args, config.controlLimits) ||
      (action === 'run_macro' &&
        !config.driver
          .macros?.(binding)
          ?.includes(typeof args.name === 'string' ? args.name : '')) ||
      (action === 'run_macro' &&
        !macroParamsAllowed(
          config.driver.macroParams?.(binding),
          String(args.name),
          args.params,
        ))
    )
      return ['unsupported', 'action not supported by this printer']
    return null
  }

  function resinPreflight(
    envelope: ApiEnvelopeV1,
    binding: PrinterBinding,
    args: z.infer<typeof ApiResinReplay>['args'],
  ) {
    const capabilities = (config.resinCapabilities?.(binding) ?? []).filter(
      (entry) => entry.assignmentId === envelope.assignment_id,
    )
    const capability = capabilities.find(
      (entry) => entry.profile === args.profile,
    )
    const decision = preflightResinArtifactReplay({
      version: {
        id: args.versionId,
        sha256: args.sha256,
        filename: args.filename,
        profile: args.profile,
      },
      requestedVersionId: args.versionId,
      plate: args.plate,
      assignmentId: envelope.assignment_id,
      targetProfile: capability?.profile ?? capabilities[0]?.profile ?? null,
      capabilities,
    })
    if (decision.status !== 'eligible') return decision
    return {
      ...decision,
      capability: capabilities.find(
        (entry) =>
          entry.profile === args.profile &&
          entry.extensions.includes(decision.extension),
      )!,
    }
  }

  function stateRefusal(
    action: DriverRequest['action'],
    binding: PrinterBinding,
    observedOverride?: ApiPrinterObservation,
  ): [ApiEnvelopeRefusalCode, string] | null {
    if (action === 'start_print' || action === 'start_library_print') {
      const plate = config.driver.plateStartRefusal?.(binding)
      if (plate) return ['wrong-state', plate]
    }
    const observed = observedOverride ?? config.observe(binding)
    if (
      !observed ||
      !observed.ready ||
      observed.printState === 'unknown' ||
      observed.printState === 'error'
    )
      return ['not-ready', 'printer not ready']
    if (controlPrinterBusy(action, observed.printState))
      return ['printer-busy', 'printer is printing']
    if (
      (action === 'start_print' || action === 'start_library_print') &&
      observed.printState !== 'idle'
    )
      return ['wrong-state', `printer is ${observed.printState}`]
    if (!controlSourceState(action, observed.printState))
      return ['wrong-state', `printer is ${observed.printState}`]
    return null
  }

  return Object.freeze({
    async run(wire: unknown): Promise<ApiCommandResult> {
      let signed
      try {
        signed = decodeApiEnvelopeFrame(wire).envelope
      } catch {
        return { kind: 'dropped', reason: 'invalid' }
      }
      const key = config.keys.issuer(API_ENVELOPE_ISSUER, signed.kid)
      if (!key) return { kind: 'dropped', reason: 'invalid-issuer' }
      const verdict = await verifyApiEnvelope(signed, key, {
        farmId: config.farmId,
        agentId: config.agentId,
        now: config.clock.wallNow(),
      })
      if (!verdict.ok) {
        if (verdict.reason === 'invalid' || verdict.reason === 'identity')
          return { kind: 'dropped', reason: 'invalid' }
        const { signature: _signature, ...claims } = signed
        return refuse(
          claims,
          'expired',
          verdict.reason === 'expired'
            ? 'envelope expired'
            : 'issued in the future',
        )
      }
      const envelope = verdict.envelope
      const denied = authorityRefusal(envelope, sample())
      if (denied) return refuse(envelope, ...denied)
      const binding = config.printer(envelope.assignment_id)
      const mapping = binding && readPrinterBinding(binding)
      if (
        !binding ||
        !mapping ||
        mapping.farm_id !== envelope.farm_id ||
        mapping.agent_id !== envelope.agent_id
      )
        return refuse(envelope, 'not-ready', 'printer not assigned here')
      if (
        mapping.assignment_id !== envelope.assignment_id ||
        config.storageDegraded?.()
      )
        return refuse(envelope, 'not-ready', 'printer or journal unavailable')
      // An environment control without a qualified capability is refused
      // before anything is journalled or sent.
      const environment = isApiEnvironmentAction(envelope.action)
        ? environmentDriverRequest(envelope.action)
        : undefined
      if (isApiEnvironmentAction(envelope.action) && !environment)
        return refuse(
          envelope,
          'unsupported',
          'no qualified capability for this environment control',
        )
      const claim = claimApiCommand(config.journal, {
        // The journal records the driver action the environment control runs.
        envelope: environment
          ? { ...envelope, action: environment as ApiEnvelopeV1['action'] }
          : envelope,
        printerKey: mapping.printer_key,
        wireSha256: createHash('sha256').update(String(wire)).digest('hex'),
      })
      if (!claim.ok) {
        if (claim.reason === 'replay')
          return { kind: 'dropped', reason: 'replay' }
        return claim.reason === 'assignment-busy' ||
          claim.reason === 'rate-limited' ||
          claim.reason === 'capacity'
          ? refuse(envelope, 'printer-busy', 'another command is in progress')
          : refuse(envelope, 'not-ready', 'command journal unavailable')
      }
      return execute(envelope, binding, claim.receipt, key)
    },
  })

  async function execute(
    envelope: ApiEnvelopeV1,
    binding: PrinterBinding,
    receipt: CommandClaimHandle,
    issuerKey: CryptoKey,
  ): Promise<ApiCommandResult> {
    const startMessage = (detail: string) => {
      if (detail === 'resin-artifact-requires-library-version')
        return RESIN_LIBRARY_START_MESSAGE
      if (
        detail === 'job delivery is not supported by this printer' ||
        (detail === 'action not supported by this printer' &&
          driverAction(envelope)?.action === 'start_library_print')
      )
        return config.driver.startUnavailableMessage?.(binding)
      return undefined
    }
    const unsafe = safetyRefusal(envelope, binding)
    if (unsafe) {
      finishCommand(config.journal, receipt, 'not-sent', 'guard-denied')
      return refuse(envelope, ...unsafe, startMessage(unsafe[1]))
    }
    const request =
      envelope.kind === 'job' && envelope.job
        ? {
            action: 'start_print' as const,
            args: { file: envelope.job.display_name },
          }
        : driverAction(envelope)
    if (!request) {
      finishCommand(config.journal, receipt, 'not-sent', 'guard-denied')
      return refuse(envelope, 'unsupported', 'missing command')
    }
    const { action, args } = request
    const run = ApiRunAction.safeParse(envelope.action)
    const plate = ApiPlateAction.safeParse(envelope.action)
    const resin = ApiResinReplay.safeParse(envelope.action)
    let runEvidence: ApiRunEvidence | undefined
    const commandStateRefusal = (): [ApiEnvelopeRefusalCode, string] | null => {
      if (request.action === 'set_tool_temperature') {
        const observed = config.observe(binding)
        const refusal = toolTemperatureRefusal(observed, request.args)
        if (refusal === 'tool-state-stale') return ['not-ready', refusal]
        if (refusal === 'tool-heater-not-advertised')
          return ['unsupported', refusal]
        if (refusal)
          return [
            observed && controlPrinterBusy(request.action, observed.printState)
              ? 'printer-busy'
              : 'wrong-state',
            refusal,
          ]
        return null
      }
      if (run.success || plate.success) {
        const observed = config.observe(binding)
        if (!observed?.ready || observed.printState === 'unknown')
          return ['not-ready', 'printer not ready']
        if (plate.success) {
          if (!['idle', 'cancelled'].includes(observed.printState))
            return ['wrong-state', 'plate-state-uncertain']
          const refusal = config.driver.apiCollectionRefusal?.(
            binding,
            plate.data.args.attempt,
          )
          return refusal ? ['wrong-state', refusal] : null
        }
        if (['idle', 'cancelled', 'error'].includes(observed.printState))
          return ['wrong-state', 'already-ended']
        const mapping = readPrinterBinding(binding)
        if (
          !run.success ||
          !mapping ||
          !runEvidence ||
          !config.apiJobs?.matchesActiveRun(
            mapping.printer_key,
            run.data.args.expectedRunId,
            runEvidence,
          )
        )
          return ['wrong-state', 'run-mismatch']
        return stateRefusal(action, binding, observed)
      }
      if (
        envelope.action?.action === 'set_fan' &&
        envelope.action.args.fan === 'chamber' &&
        envelope.action.args.percent === 0
      ) {
        const observed = config.observe(binding)
        return (
          environmentInterlock(
            { action: 'extraction_set', args: { percent: 0 } },
            observed,
          ) ?? stateRefusal(action, binding, observed ?? undefined)
        )
      }
      if (isApiEnvironmentAction(envelope.action)) {
        const observed = config.observe(binding)
        return (
          environmentInterlock(envelope.action, observed) ??
          stateRefusal(action, binding, observed ?? undefined)
        )
      }
      return stateRefusal(action, binding)
    }
    let refusalMessage: string | undefined
    let lastRefusal: [ApiEnvelopeRefusalCode, string] | null = null
    let guardCalled = false
    let permitted = false
    let acknowledged = false
    let attempted = false
    let sentMono = 0
    let sentAt = 0
    let confirmed = true
    let threw = false
    let prepared = false
    let jobWatch: ReturnType<ApiJobLifecycle['watch']> | undefined
    const postWrite =
      envelope.kind === 'action' &&
      action === 'home' &&
      config.driver.allowsExtendedResult?.(binding) === true
        ? new AbortController()
        : undefined
    const executeMs = Math.max(
      1,
      Math.min(
        envelope.kind === 'job' ? 60_000 : MAX_EXECUTE_MS,
        envelope.expires_at - config.clock.wallNow(),
      ),
    )
    const deadline = postWrite?.signal ?? AbortSignal.timeout(executeMs)
    const writeDeadline = postWrite
      ? config.clock.monotonicNow() + executeMs
      : Infinity
    let resultDeadline = Infinity
    let postWriteTimer = postWrite
      ? setTimeout(() => postWrite.abort(), executeMs)
      : undefined
    const signal = config.signal
      ? AbortSignal.any([config.signal, deadline])
      : deadline
    const beforeSend = (): boolean => {
      if (guardCalled) {
        // A second guard call breaks the one-send contract: treat as uncertain.
        threw = true
        return false
      }
      guardCalled = true
      if (signal.aborted || config.storageDegraded?.()) return false
      if (!markWriteStarted(config.journal, receipt)) return false
      const now = sample()
      lastRefusal =
        postWrite && now.mono >= writeDeadline
          ? ['expired', 'write deadline elapsed']
          : config.keys.issuer(API_ENVELOPE_ISSUER, envelope.kid) !== issuerKey
            ? ['grant-revoked', 'issuer no longer trusted']
            : (authorityRefusal(envelope, now) ??
              safetyRefusal(envelope, binding) ??
              commandStateRefusal())
      if (lastRefusal || signal.aborted || !readPrinterBinding(binding))
        return false
      sentMono = now.mono
      sentAt = now.wall
      if (postWrite) {
        clearTimeout(postWriteTimer)
        resultDeadline = now.mono + U1_CONTROL_RESULT_TIMEOUT_MS
        postWriteTimer = setTimeout(
          () => postWrite.abort(),
          U1_CONTROL_RESULT_TIMEOUT_MS,
        )
      }
      permitted = true
      return true
    }
    const executeDriver = async (
      driverRequest: DriverRequest = request,
      onSend?: (sentAt: number) => void,
    ) => {
      if (!prepared) {
        await config.driver.prepare?.({
          binding,
          signal,
          ...(run.success
            ? {
                observeRun(evidence) {
                  runEvidence = evidence
                },
              }
            : {}),
        })
        prepared = true
      }
      lastRefusal =
        authorityRefusal(envelope, sample()) ?? commandStateRefusal()
      if (!lastRefusal && !signal.aborted) {
        attempted = true
        acknowledged =
          (
            await config.driver.execute!(
              driverRequest.action,
              driverRequest.args,
              {
                binding,
                beforeSend() {
                  if (!beforeSend()) return false
                  try {
                    onSend?.(sentAt)
                    return true
                  } catch {
                    permitted = false
                    lastRefusal = ['not-ready', 'API job journal unavailable']
                    return false
                  }
                },
                signal,
              },
            )
          ).acknowledged === true
        if (permitted && acknowledged)
          confirmed = config.confirmEffect
            ? await config.confirmEffect(driverRequest, {
                binding,
                sentMono,
                signal,
              })
            : !run.success
      }
    }
    try {
      if (plate.success) {
        await config.driver.prepare?.({ binding, signal })
        if (beforeSend()) {
          config.driver.confirmApiCollection!(binding, plate.data.args.attempt)
          acknowledged = true
        }
      } else if (resin.success) {
        const artifact = resin.data.args
        const decision = resinPreflight(envelope, binding, artifact)
        if (
          decision.status !== 'eligible' ||
          !config.libraryPrint?.withVerifiedArtifact
        )
          throw new JobFileError('unsupported')
        lastRefusal = commandStateRefusal()
        if (!lastRefusal) {
          const result = await config.libraryPrint.withVerifiedArtifact(
            artifact.sha256,
            signal,
            async (path) => {
              const { capability } = decision
              const verified = await capability.validate({
                filename: artifact.filename,
                path,
                signal,
              })
              if (!verified.ok) {
                lastRefusal = [
                  'unsupported',
                  verified.reason.replace(/[^a-z0-9-]/g, '').slice(0, 100) ||
                    'invalid-resin-artifact',
                ]
                return
              }
              lastRefusal =
                authorityRefusal(envelope, sample()) ??
                safetyRefusal(envelope, binding) ??
                commandStateRefusal()
              if (lastRefusal || signal.aborted) return
              const beforeResinSend = () => {
                const current = resinPreflight(envelope, binding, artifact)
                if (
                  current.status !== 'eligible' ||
                  current.capability !== capability
                ) {
                  guardCalled = true
                  lastRefusal = [
                    'unsupported',
                    'resin-artifact-dispatch-unavailable',
                  ]
                  return false
                }
                return beforeSend()
              }
              attempted = true
              const sdcp = readSdcpPrinterBinding(binding)
              const startVerifiedSdcp = async () => {
                await config.driver.prepare?.({ binding, signal })
                return (
                  await config.driver.execute!(
                    'start_print',
                    { file: artifact.filename },
                    {
                      binding,
                      signal,
                      beforeSend: beforeResinSend,
                      verifiedResinFilename: artifact.filename,
                    },
                  )
                ).acknowledged
              }
              acknowledged = await capability.dispatch({
                filename: artifact.filename,
                path,
                binding,
                signal,
                beforeSend: sdcp ? () => false : beforeResinSend,
                ...(sdcp && config.driver.execute ? { startVerifiedSdcp } : {}),
              })
            },
          )
          if (!result.ok)
            lastRefusal = [
              result.code === 'checksum-mismatch' ? result.code : 'not-ready',
              result.code,
            ]
        }
      } else if (action === 'start_library_print') {
        const mapping = readPrinterBinding(binding)
        const target = jobTarget(binding)
        const parsed = LibraryPrintArgs.safeParse(args)
        if (!target || !config.libraryPrint || !parsed.success)
          throw new JobFileError('unsupported')
        // Authorization needs the same fresh local observation as file jobs.
        await config.driver.prepare?.({ binding, signal })
        prepared = true
        const authorize = () => {
          lastRefusal =
            config.keys.issuer(API_ENVELOPE_ISSUER, envelope.kid) !== issuerKey
              ? ['grant-revoked', 'issuer no longer trusted']
              : (authorityRefusal(envelope, sample()) ??
                safetyRefusal(envelope, binding) ??
                commandStateRefusal())
          return (
            !lastRefusal &&
            !signal.aborted &&
            !config.storageDegraded?.() &&
            readPrinterBinding(binding) === mapping
          )
        }
        const outcome = await config.libraryPrint.start({
          args: parsed.data,
          target,
          signal,
          authorize,
          start: (file, extra) =>
            executeDriver(
              { action: 'start_print', args: { file, ...extra } },
              (at) => {
                if (mapping)
                  config.libraryLinks?.remember(
                    mapping.printer_key,
                    {
                      name: file,
                      sha256: parsed.data.sha256,
                      ...(parsed.data.plate === undefined
                        ? {}
                        : { plate: parsed.data.plate }),
                    },
                    at,
                  )
              },
            ),
        })
        if (!outcome.ok && !attempted)
          lastRefusal ??= [
            outcome.code === 'checksum-mismatch' ||
            outcome.code === 'unsupported'
              ? outcome.code
              : 'not-ready',
            outcome.code,
          ]
      } else if (envelope.kind === 'job' && envelope.job) {
        const mapping = readPrinterBinding(binding)
        const target = jobTarget(binding)
        if (!target || !config.jobFiles) throw new JobFileError('unsupported')
        // The file fetch is authorized against a fresh local observation.
        // Open the control attempt first; executeDriver reuses it.
        await config.driver.prepare?.({ binding, signal })
        prepared = true
        const authorize = () => {
          lastRefusal =
            config.keys.issuer(API_ENVELOPE_ISSUER, envelope.kid) !== issuerKey
              ? ['grant-revoked', 'issuer no longer trusted']
              : (authorityRefusal(envelope, sample()) ??
                safetyRefusal(envelope, binding) ??
                commandStateRefusal())
          return (
            !lastRefusal &&
            !signal.aborted &&
            !config.storageDegraded?.() &&
            readPrinterBinding(binding) === mapping
          )
        }
        if (!authorize()) throw new Error('unauthorized')
        await fetchJobFile({
          job: envelope.job,
          target,
          directory: config.jobFiles.directory,
          signal,
          authorize,
          start: (filename) =>
            executeDriver(request, (at) => {
              if (mapping && target.backend === 'moonraker')
                jobWatch = config.apiJobs?.watch(
                  mapping.printer_key,
                  filename,
                  envelope.cmd_id,
                  at,
                  sentMono,
                )
            }),
          ...(config.jobFiles.ca ? { ca: config.jobFiles.ca } : {}),
        })
      } else await executeDriver()
    } catch (error) {
      // Like the browser dispatcher, trust only the driver's typed local
      // refusals before the write guard. They certify that nothing was sent.
      if (
        attempted &&
        !permitted &&
        !guardCalled &&
        error instanceof DriverRefusalError
      ) {
        attempted = false
        refusalMessage = error.userMessage
        lastRefusal = [
          error.refusal === 'state' ? 'wrong-state' : 'unsupported',
          error.refusal,
        ]
      }
      if (
        !guardCalled &&
        error instanceof Error &&
        'resultCode' in error &&
        error.resultCode === 'awaiting-collection'
      ) {
        attempted = false
        lastRefusal = ['wrong-state', 'awaiting-collection']
      }
      if (!attempted && error instanceof JobFileError)
        lastRefusal = [
          error.reason === 'checksum-mismatch'
            ? 'checksum-mismatch'
            : error.reason === 'unsupported'
              ? 'unsupported'
              : 'not-ready',
          error.reason,
        ]
      threw = true
    } finally {
      try {
        await config.driver.closeAttempt?.(binding)
      } catch {
        threw = true
      }
      clearTimeout(postWriteTimer)
    }
    // Losing the inbox after positive local confirmation only affects reporting.
    const interrupted =
      (signal.aborted ||
        (postWrite && config.clock.monotonicNow() >= resultDeadline)) &&
      !(jobWatch && acknowledged && confirmed)
    if (threw || interrupted || !acknowledged || !confirmed) jobWatch?.dispose()
    if (attempted && !guardCalled) {
      finishCommand(
        config.journal,
        receipt,
        'outcome-unknown',
        'driver-contract',
      )
      return { kind: 'outcome-unknown' }
    }
    if (!permitted) {
      finishCommand(config.journal, receipt, 'not-sent', 'guard-denied')
      const [code, detail]: [ApiEnvelopeRefusalCode, string] = (lastRefusal as
        [ApiEnvelopeRefusalCode, string] | null) ?? [
        'not-ready',
        'printer not reachable',
      ]
      return refuse(
        envelope,
        code,
        detail,
        refusalMessage ?? startMessage(detail),
      )
    }
    if (threw || interrupted || !acknowledged) {
      finishCommand(config.journal, receipt, 'outcome-unknown', 'rpc-unknown')
      return { kind: 'outcome-unknown' }
    }
    if (!confirmed) {
      finishCommand(
        config.journal,
        receipt,
        'outcome-unknown',
        'state-unconfirmed',
      )
      return { kind: 'outcome-unknown' }
    }
    if (
      !finishCommand(config.journal, receipt, 'applied', 'rpc-acknowledged')
    ) {
      jobWatch?.dispose()
      return { kind: 'outcome-unknown' }
    }
    if (jobWatch) {
      try {
        jobWatch.confirm()
      } catch {
        jobWatch.dispose()
        return { kind: 'outcome-unknown' }
      }
    } else send(envelope, envelope.kind === 'job' ? 'started' : 'completed')
    return { kind: 'completed' }
  }
}

/** One claim confirmation per inbox delivery. Credential refreshes never renew it. */
export async function receiveApiCommand(
  config: Omit<
    Parameters<typeof createApiCommandRunner>[0],
    'grants' | 'report' | 'signal'
  >,
  frame: Extract<SignallingServerFrame, { t: 'connector.api-command' }>,
  inbox: {
    signal: AbortSignal
    report(wire: string): void
    freshness: CachedAuthorityFreshness
    apiJobs?: ApiJobLifecycle | undefined
  },
) {
  const { envelope } = decodeApiEnvelopeFrame(frame.wire)
  const hasSignedGrant =
    envelope.scope !== undefined || envelope.grant_epoch !== undefined
  const authority = createOfflineAuthority()
  const wall = config.clock.wallNow()
  const mono = config.clock.monotonicNow()
  const age = wall - frame.confirmed_at
  if (age >= -OFFLINE_AUTHORITY_MAX_SKEW_MS && age < authority.maxAgeMs) {
    // Keep time already spent in delivery inside the lifetime, including on new processes.
    const receivedAt = { wall, mono }
    authority.confirm(receivedAt, 1)
  }
  const runner = createApiCommandRunner({
    ...config,
    report: inbox.report,
    apiJobs: inbox.apiJobs ?? config.apiJobs,
    signal: inbox.signal,
    grants: {
      lookup: (id) =>
        id === envelope.grant_id
          ? {
              grant_id: id,
              app_id: envelope.app_id,
              farm_id: envelope.farm_id,
              scopes:
                !hasSignedGrant || envelope.scope === frame.scope
                  ? [frame.scope]
                  : [],
              revoked:
                hasSignedGrant &&
                (envelope.scope === undefined ||
                  envelope.grant_epoch !== envelope.issued_at ||
                  frame.confirmed_at < envelope.grant_epoch),
            }
          : undefined,
      freshness: {
        freshAt(now) {
          return (
            authority.freshness.freshAt(now) &&
            inbox.freshness.freshAt(now) &&
            Math.max(0, age) + now.mono - mono < authority.maxAgeMs
          )
        },
      },
    },
  })
  return runner.run(frame.wire)
}
