import { randomUUID } from 'node:crypto'
import { record } from './discovery.ts'

/** One printer report as seen on `<type>/report` (clean-room spec, "Requests, acknowledgements and outcomes"). */
export interface KobraXReport {
  type: string
  action: string
  msgid: string
  state: string | undefined
  code: number | undefined
  data: Record<string, unknown>
}

/**
 * The outcomes of the spec, plus `unanswered` for a request that did not even
 * get the transport acknowledgement. An acknowledgement alone is never success.
 */
export type KobraXOutcome<T = undefined> =
  | { kind: 'confirmed'; report: KobraXReport; data: T }
  | {
      kind: 'refused'
      /** `local`: refused before publishing. `printer`: refused by the printer. */
      stage: 'local' | 'printer'
      reason: string
      code?: number
    }
  | { kind: 'received' }
  | { kind: 'unanswered' }

export function refusedLocally(reason: string): KobraXOutcome<never> {
  return { kind: 'refused', stage: 'local', reason }
}

export function parseKobraXReport(
  type: string,
  payload: unknown,
): KobraXReport | undefined {
  const message = record(payload)
  if (typeof message.action !== 'string') return undefined
  const code = message.code
  return {
    type,
    action: message.action,
    msgid: typeof message.msgid === 'string' ? message.msgid : '',
    state: typeof message.state === 'string' ? message.state : undefined,
    code: typeof code === 'number' && Number.isFinite(code) ? code : undefined,
    data: record(message.data),
  }
}

/** A code other than 0 or 200, or a `failed` state, is a refusal (spec outcome table). */
export function reportRefusal(report: KobraXReport): number | 'failed' | null {
  if (report.state === 'failed') return report.code ?? 'failed'
  if (report.code !== undefined && report.code !== 0 && report.code !== 200)
    return report.code
  return null
}

export interface KobraXRequestSpec<T = undefined> {
  type: string
  action: string
  data?: Record<string, unknown>
  /** Wait for a result. Home takes tens of seconds on a real printer. */
  resultTimeoutMs?: number | undefined
  /** Only reports passing this filter can settle the request (for example: same file name). */
  accept?(report: KobraXReport): boolean
  /** A successful report must show the requested effect to confirm. */
  effect?(report: KobraXReport): boolean
  /** Maps the confirming report to the data of the outcome. */
  result?(report: KobraXReport): T
  /** Last check before the single send. False sends nothing. */
  beforeSend(): boolean
  signal?: AbortSignal
}

export function createKobraXRequests(input: {
  topic(type: string): string
  publish(topic: string, payload: string, failed: (error: Error) => void): void
  resultTimeoutMs?: number
}) {
  const defaultTimeout = input.resultTimeoutMs ?? 5000
  const acks = new Map<string, (code: number | undefined) => void>()
  const listeners = new Set<(report: KobraXReport) => void>()
  /** In-flight request msgids so a reply named for another request cannot settle this one. */
  const inflight = new Set<string>()

  /** Acknowledgement on `<deviceId>/response`: "received" only. */
  function handleAck(payload: unknown) {
    const message = record(payload)
    if (typeof message.msgid !== 'string') return
    const code = message.code
    acks.get(message.msgid)?.(typeof code === 'number' ? code : undefined)
  }

  function handleReport(report: KobraXReport) {
    for (const listener of [...listeners]) listener(report)
  }

  function onReport(listener: (report: KobraXReport) => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function send<T = undefined>(
    spec: KobraXRequestSpec<T>,
  ): Promise<KobraXOutcome<T>> {
    return new Promise((resolve) => {
      if (spec.signal?.aborted) {
        resolve(refusedLocally('aborted'))
        return
      }
      const msgid = randomUUID()
      let acked = false
      let finished = false
      let timer: NodeJS.Timeout | undefined
      let stop: () => void = () => {}
      function finish(outcome: KobraXOutcome<T>) {
        if (finished) return
        finished = true
        clearTimeout(timer)
        acks.delete(msgid)
        inflight.delete(msgid)
        stop()
        spec.signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      function onAbort() {
        finish(acked ? { kind: 'received' } : { kind: 'unanswered' })
      }
      // Own msgid always matches. A report msgid that names another in-flight
      // request must not settle this one (#616). Otherwise S1 printers choose
      // their own report msgid (or omit it), so type+action still applies.
      const ownsReport = (report: KobraXReport) => {
        if (report.msgid === msgid) return true
        if (report.msgid && inflight.has(report.msgid)) return false
        return report.type === spec.type && report.action === spec.action
      }
      stop = onReport((report) => {
        if (!ownsReport(report)) return
        const refusal = reportRefusal(report)
        // A failure report may carry no payload to match; it still refuses.
        const matches =
          !spec.accept ||
          spec.accept(report) ||
          (refusal !== null && Object.keys(report.data).length === 0)
        if (!matches) return
        if (refusal !== null) {
          finish({
            kind: 'refused',
            stage: 'printer',
            reason: 'printer-refused',
            ...(typeof refusal === 'number' ? { code: refusal } : {}),
          })
          return
        }
        if (spec.effect && !spec.effect(report)) return
        finish({
          kind: 'confirmed',
          report,
          data: (spec.result ? spec.result(report) : undefined) as T,
        })
      })
      inflight.add(msgid)
      acks.set(msgid, (code) => {
        if (code !== undefined && code !== 0 && code !== 200) {
          finish({
            kind: 'refused',
            stage: 'printer',
            reason: 'ack-refused',
            code,
          })
          return
        }
        acked = true
      })
      spec.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(
        () => finish(acked ? { kind: 'received' } : { kind: 'unanswered' }),
        spec.resultTimeoutMs ?? defaultTimeout,
      )
      // The guard and the one publish share this synchronous stack.
      let allowed = false
      try {
        allowed = spec.beforeSend() === true
      } catch {
        allowed = false
      }
      if (!allowed) {
        finish(refusedLocally('not-authorized'))
        return
      }
      try {
        input.publish(
          input.topic(spec.type),
          JSON.stringify({
            type: spec.type,
            action: spec.action,
            msgid,
            timestamp: Date.now(),
            data: spec.data ?? {},
          }),
          () => finish({ kind: 'unanswered' }),
        )
      } catch {
        finish({ kind: 'unanswered' })
      }
    })
  }

  return { send, handleAck, handleReport, onReport }
}
export type KobraXRequests = ReturnType<typeof createKobraXRequests>
