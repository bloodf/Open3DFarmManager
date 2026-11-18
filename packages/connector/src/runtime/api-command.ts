import { createHash } from 'node:crypto'
import {
  API_ENVELOPE_ISSUER,
  decodeApiEnvelopeFrame,
  encodeApiEnvelopeResultFrame,
  verifyApiEnvelope,
  type ApiEnvelopeRefusalCode,
  type ApiEnvelopeV1,
} from '../../../farm-protocol/src/api-envelope.ts'
import { controlSourceState } from '../../../farm-protocol/src/control-actions.ts'
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
  'execute' | 'controls' | 'macros'
> &
  Partial<Pick<PreparedPauseDriver, 'prepare' | 'closeAttempt'>>
export type ApiCommandResult =
  /** Unauthenticated, not ours, or a replay: nothing is reported. */
  | { kind: 'dropped'; reason: 'invalid' | 'replay' }
  | { kind: 'refused'; code: ApiEnvelopeRefusalCode; detail?: string }
  | { kind: 'completed' }
  /** The send may have happened; nothing is reported and nothing is retried. */
  | { kind: 'outcome-unknown' }

const CONTROL_BASIC = new Set(['pause', 'resume', 'cancel'])
/** Motion and macros never run while a print owns the printer. */
const IDLE_ONLY = new Set([
  'home',
  'load_filament',
  'unload_filament',
  'run_macro',
])
const MAX_EXECUTE_MS = 5000

/** The scope a grant must hold for this envelope; mirrors the server's issue check. */
export function apiEnvelopeScope(envelope: ApiEnvelopeV1): string {
  if (envelope.kind === 'job') return 'jobs:start'
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
}) {
  const sample = (): AuthoritySample => ({
    wall: config.clock.wallNow(),
    mono: config.clock.monotonicNow(),
  })
  function send(
    envelope: ApiEnvelopeV1,
    outcome: 'refused' | 'completed',
    code?: ApiEnvelopeRefusalCode,
    detail?: string,
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
  function safetyRefusal(
    envelope: ApiEnvelopeV1,
    binding: PrinterBinding,
  ): [ApiEnvelopeRefusalCode, string] | null {
    if (envelope.kind === 'job')
      return ['unsupported', 'job delivery is not supported yet']
    const { action, args } = envelope.action!
    if (
      !config.driver.execute ||
      !(config.driver.controls?.(binding) ?? []).includes(action) ||
      !controlWithinLimits(action, args, config.controlLimits) ||
      (action === 'run_macro' &&
        !config.driver
          .macros?.(binding)
          ?.includes(typeof args.name === 'string' ? args.name : ''))
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
    if (
      IDLE_ONLY.has(action) &&
      (observed.printState === 'printing' || observed.printState === 'paused')
    )
      return ['printer-busy', 'printer is printing']
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
      if (!key) return { kind: 'dropped', reason: 'invalid' }
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
    const request = envelope.action
    if (!request) {
      finishCommand(config.journal, receipt, 'not-sent', 'guard-denied')
      return refuse(envelope, 'unsupported', 'job delivery is unavailable')
    }
    const { action, args } = request
    let lastRefusal: [ApiEnvelopeRefusalCode, string] | null = null
    let guardCalled = false
    let permitted = false
    let acknowledged = false
    let attempted = false
    let sentMono = 0
    let confirmed = true
    let threw = false
    const deadline = AbortSignal.timeout(
      Math.max(
        1,
        Math.min(MAX_EXECUTE_MS, envelope.expires_at - config.clock.wallNow()),
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
      permitted = true
      return true
    }
    try {
      await config.driver.prepare?.({ binding, signal })
      lastRefusal =
        authorityRefusal(envelope, sample()) ?? stateRefusal(action, binding)
      if (!lastRefusal && !signal.aborted) {
        attempted = true
        acknowledged =
          (
            await config.driver.execute!(action, args, {
              binding,
              beforeSend,
              signal,
            })
          ).acknowledged === true
        if (permitted && acknowledged && config.confirmEffect)
          confirmed = await config.confirmEffect(request, {
            binding,
            sentMono,
            signal,
          })
      }
    } catch {
      threw = true
    } finally {
      try {
        await config.driver.closeAttempt?.(binding)
      } catch {
        threw = true
      }
    }
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
    if (!finishCommand(config.journal, receipt, 'applied', 'rpc-acknowledged'))
      return { kind: 'outcome-unknown' }
    send(envelope, 'completed')
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
              scopes: [frame.scope],
              revoked: false,
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
