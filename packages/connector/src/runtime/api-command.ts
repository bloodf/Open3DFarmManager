import { createHash } from 'node:crypto'
import {
  API_ENVELOPE_ISSUER,
  decodeApiEnvelopeFrame,
  encodeApiEnvelopeResultFrame,
  verifyApiEnvelope,
  type ApiEnvelopeRefusalCode,
  type ApiEnvelopeV1,
} from '../../../farm-protocol/src/api-envelope.ts'
import {
  controlPrinterBusy,
  controlSourceState,
  LibraryPrintArgs,
  LIBRARY_PRINT_API_SCOPE,
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
import type { PreparedPauseDriver } from '../control/pause-dispatcher.ts'
import {
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import { controlWithinLimits, type ControlLimits } from './control-limits.ts'
import { fetchJobFile, JobFileError } from './job-file-fetch.ts'
import { supportsFileUpload, type FileUploadTarget } from './file-upload.ts'
import type { createLibraryPrintStarter } from './library-print-start.ts'
import { watchApiJob } from './api-job-lifecycle.ts'
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
}>
export type ApiCommandDriver = Pick<
  PreparedPauseDriver,
  'execute' | 'controls' | 'macros' | 'macroParams'
> &
  Partial<Pick<PreparedPauseDriver, 'prepare' | 'closeAttempt'>>
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

const CONTROL_BASIC = new Set(['pause', 'resume', 'cancel'])
const MAX_EXECUTE_MS = 5000

/** The scope a grant must hold for this envelope; mirrors the server's issue check. */
export function apiEnvelopeScope(envelope: ApiEnvelopeV1): string {
  if (envelope.kind === 'job') return 'jobs:start'
  if (envelope.action!.action === 'start_library_print')
    return LIBRARY_PRINT_API_SCOPE
  return CONTROL_BASIC.has(envelope.action!.action)
    ? 'control:basic'
    : 'control:extended'
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
  observe(binding: PrinterBinding): ApiPrinterObservation | null
  driver: ApiCommandDriver
  /** Sends one encoded `api-envelope.result` frame over the inbox. */
  report(wire: string): void
  clock: { wallNow(): number; monotonicNow(): number }
  controlLimits?: ControlLimits
  confirmEffect?: (
    action: NonNullable<ApiEnvelopeV1['action']>,
    input: { binding: PrinterBinding; sentMono: number; signal: AbortSignal },
  ) => Promise<boolean>
  storageDegraded?: () => boolean
  signal?: AbortSignal
  jobFiles?: {
    directory: string
    targetFor(printerKey: string): FileUploadTarget | undefined
    ca?: string | Buffer
  }
  /** Library print starts; without it `start_library_print` is refused as unsupported. */
  libraryPrint?: ReturnType<typeof createLibraryPrintStarter>
  /** Remembers what a library start printed so the finished job links to it (#385). */
  libraryLinks?: Pick<LibraryJobLinks, 'remember'>
}) {
  const sample = (): AuthoritySample => ({
    wall: config.clock.wallNow(),
    mono: config.clock.monotonicNow(),
  })
  function send(
    envelope: ApiEnvelopeV1,
    outcome: 'refused' | 'completed' | 'started' | 'cancelled' | 'failed',
    code?: ApiEnvelopeRefusalCode,
    detail?: string,
    endedAt?: number,
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
          // PostgreSQL identity IDs have no leading zero. The Farm resolves
          // this timestamp reference against the telemetry history row.
          ...(endedAt === undefined ? {} : { history_entry_id: `0${endedAt}` }),
          at: endedAt ?? config.clock.wallNow(),
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
  ): ApiCommandResult {
    send(envelope, 'refused', code, detail)
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
    if (!grant.scopes.includes(apiEnvelopeScope(envelope)))
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
      if (
        !target ||
        !envelope.job ||
        !supportsFileUpload(target, envelope.job.display_name) ||
        !config.driver.execute ||
        !(config.driver.controls?.(binding) ?? []).includes('start_print')
      )
        return ['unsupported', 'job delivery is not supported by this printer']
      return null
    }
    const { action, args } = envelope.action!
    // A library start runs the driver's ordinary `start_print` after the file is in place.
    const libraryStart = action === 'start_library_print'
    if (
      !config.driver.execute ||
      (libraryStart && (!config.libraryPrint || !jobTarget(binding))) ||
      !(config.driver.controls?.(binding) ?? []).includes(
        libraryStart ? 'start_print' : action,
      ) ||
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

  function stateRefusal(
    action: NonNullable<ApiEnvelopeV1['action']>['action'],
    binding: PrinterBinding,
  ): [ApiEnvelopeRefusalCode, string] | null {
    const observed = config.observe(binding)
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
      const claim = claimApiCommand(config.journal, {
        envelope,
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
    const unsafe = safetyRefusal(envelope, binding)
    if (unsafe) {
      finishCommand(config.journal, receipt, 'not-sent', 'guard-denied')
      return refuse(envelope, ...unsafe)
    }
    const request =
      envelope.kind === 'job' && envelope.job
        ? {
            action: 'start_print' as const,
            args: { file: envelope.job.display_name },
          }
        : envelope.action
    if (!request) {
      finishCommand(config.journal, receipt, 'not-sent', 'guard-denied')
      return refuse(envelope, 'unsupported', 'missing command')
    }
    const { action, args } = request
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
    let jobWatch: ReturnType<typeof watchApiJob> | undefined
    const deadline = AbortSignal.timeout(
      Math.max(
        1,
        Math.min(
          envelope.kind === 'job' ? 60_000 : MAX_EXECUTE_MS,
          envelope.expires_at - config.clock.wallNow(),
        ),
      ),
    )
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
        config.keys.issuer(API_ENVELOPE_ISSUER, envelope.kid) !== issuerKey
          ? ['grant-revoked', 'issuer no longer trusted']
          : (authorityRefusal(envelope, now) ??
            safetyRefusal(envelope, binding) ??
            stateRefusal(action, binding))
      if (lastRefusal || signal.aborted || !readPrinterBinding(binding))
        return false
      sentMono = now.mono
      sentAt = now.wall
      permitted = true
      return true
    }
    const executeDriver = async (
      driverRequest: NonNullable<ApiEnvelopeV1['action']> = request,
      onSend?: (sentAt: number) => void,
    ) => {
      if (!prepared) {
        await config.driver.prepare?.({ binding, signal })
        prepared = true
      }
      lastRefusal =
        authorityRefusal(envelope, sample()) ?? stateRefusal(action, binding)
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
                  onSend?.(sentAt)
                  return true
                },
                signal,
              },
            )
          ).acknowledged === true
        if (permitted && acknowledged && config.confirmEffect)
          confirmed = await config.confirmEffect(driverRequest, {
            binding,
            sentMono,
            signal,
          })
      }
    }
    try {
      if (action === 'start_library_print') {
        const mapping = readPrinterBinding(binding)
        const target = jobTarget(binding)
        const parsed = LibraryPrintArgs.safeParse(args)
        if (!target || !config.libraryPrint || !parsed.success)
          throw new JobFileError('unsupported')
        const authorize = () => {
          lastRefusal =
            config.keys.issuer(API_ENVELOPE_ISSUER, envelope.kid) !== issuerKey
              ? ['grant-revoked', 'issuer no longer trusted']
              : (authorityRefusal(envelope, sample()) ??
                safetyRefusal(envelope, binding) ??
                stateRefusal(action, binding))
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
          lastRefusal = [
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
                stateRefusal(action, binding))
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
                jobWatch = watchApiJob(
                  mapping.printer_key,
                  filename,
                  at,
                  sentMono,
                  config.signal,
                )
            }),
          ...(config.jobFiles.ca ? { ca: config.jobFiles.ca } : {}),
        })
      } else await executeDriver()
    } catch (error) {
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
    }
    if (threw || signal.aborted || !acknowledged || !confirmed)
      jobWatch?.dispose()
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
      return refuse(envelope, code, detail)
    }
    if (threw || signal.aborted || !acknowledged) {
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
    send(envelope, envelope.kind === 'job' ? 'started' : 'completed')
    jobWatch?.confirmed((job) =>
      send(envelope, job.outcome, undefined, undefined, job.endedAt),
    )
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
