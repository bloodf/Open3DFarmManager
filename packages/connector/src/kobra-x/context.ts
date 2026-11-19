import type { KobraXFactsTracker } from './facts.ts'
import type { KobraXPrinterState } from './gate.ts'
import {
  refusedLocally,
  type KobraXOutcome,
  type KobraXRequestSpec,
  type KobraXRequests,
} from './requests.ts'
import { kobraXGate, type KobraXGateAction } from './gate.ts'

/**
 * Every command carries the Connector's own last-moment authorization. A
 * missing or false guard sends nothing, so an unsigned or revoked command can
 * never reach the printer. Reads (list, details) need no guard.
 */
export interface KobraXCall {
  beforeSend(): boolean
  signal?: AbortSignal
}

export interface KobraXControlContext {
  requests: KobraXRequests
  facts: KobraXFactsTracker
  /** Last reported printer state. */
  state(): KobraXPrinterState
  address: string
  httpPort: number
  token: string
  fetch?: typeof fetch
  resultTimeoutMs?: number
  /** Home and jog answer only when the move is done. */
  motionResultTimeoutMs?: number
  /** One command at a time per printer. */
  claim(): (() => void) | undefined
}

export const noGuard: KobraXCall = { beforeSend: () => true }

/** Gate, claim the printer, send once. The only path any action takes to the wire. */
export async function runGated<T = undefined>(
  context: KobraXControlContext,
  gate: {
    action: KobraXGateAction
    slot?: number | undefined
    filename?: string | undefined
  },
  call: KobraXCall | undefined,
  spec: Omit<KobraXRequestSpec<T>, 'beforeSend' | 'signal'>,
): Promise<KobraXOutcome<T>> {
  const read = gate.action === 'file-list' || gate.action === 'file-details'
  if (!call && !read) return refusedLocally('not-authorized')
  const reason = kobraXGate({
    ...gate,
    state: context.state(),
    facts: context.facts.get(),
  })
  if (reason) return refusedLocally(reason)
  const release = read ? () => {} : context.claim()
  if (!release) return refusedLocally('busy')
  try {
    const resolved = call ?? noGuard
    return await context.requests.send<T>({
      resultTimeoutMs: context.resultTimeoutMs,
      ...spec,
      beforeSend: resolved.beforeSend,
      ...(resolved.signal ? { signal: resolved.signal } : {}),
    })
  } finally {
    release()
  }
}
