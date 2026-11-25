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
  | {
      kind: 'confirmed'
      report: KobraXReport
      data: T
      /** True only when the report carries this request's own msgid. */
      correlated: boolean
      effectMatches?: (report: KobraXReport) => boolean
    }
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
  if (message.type !== undefined && message.type !== type) return undefined
  const code = message.code
  return {
    type,
    action: message.action,
    msgid: typeof message.msgid === 'string' ? message.msgid : '',
    state: typeof message.state === 'string' ? message.state : undefined,
    code:
      code === undefined ? undefined : typeof code === 'number' ? code : NaN,
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

/**
 * How a printer names its reports.
 *
 * Wire format: the ack on `<deviceId>/response` carries the request's `msgid`;
 * the answer on `<type>/report` was observed with a `msgid` the printer made
 * (firmware 2.0.2.8; bloodf/kobracontrol@c414db4f36d4c96f2b232c368ad6cfe56e3d0408
 * docs/protocol.md, "Requests and replies"). The request envelope is
 * bloodf/OrcaSlicer@d0a76d08d3493352c6c575ee242e2d71356e400e
 * src/slic3r/Utils/KobraX.cpp, `request`.
 *
 * - `exact` (default): a report settles a request only with the request's own
 *   `msgid`, `type` and `action`.
 * - `printer-assigned`: for firmware that answers on `<type>/report` with its
 *   own `msgid`, or none (docs/compatibility/kobra-x-lan.md, "Requests,
 *   acknowledgements and outcomes"). A report can settle a request only after
 *   the printer acknowledged that request's `msgid`, when it has the same
 *   `type` and `action`, and when it carries no `msgid` this connection ever
 *   issued. Exactly one acknowledged request may wait on that type and action;
 *   with two, neither settles by this route. Any other unsettled request on
 *   that type and action, acknowledged or not, also blocks it, and so does a
 *   request on that type and action that ended without a result in the last
 *   `lateReportMs`, because its report may still arrive. A report the printer sent for
 *   another client that fits all of this cannot be told apart, so this mode
 *   is opt-in per printer (`KobraXBinding.reportIdentity`) and never the
 *   default.
 */
export type KobraXReportIdentity = 'exact' | 'printer-assigned'

/** Bound on the msgids remembered as ours; far above any in-flight count. */
const issuedLimit = 512
/** How long a request that ended without a result may still own a late report. */
const lateReportMs = 30_000

export function createKobraXRequests(input: {
  topic(type: string): string
  publish(topic: string, payload: string, failed: (error: Error) => void): void
  resultTimeoutMs?: number
  reportIdentity?: KobraXReportIdentity
}) {
  const defaultTimeout = input.resultTimeoutMs ?? 5000
  const printerAssigned = input.reportIdentity === 'printer-assigned'
  const acks = new Map<string, (code: number | undefined) => void>()
  const listeners = new Set<(report: KobraXReport) => void>()
  /** Every msgid this connection published, oldest first. */
  const issued = new Set<string>()
  /** Unsettled requests by msgid, for the printer-assigned route. */
  const waiting = new Map<
    string,
    {
      type: string
      action: string
      acked: boolean
      /** Exact match: this request's own msgid, type and action. */
      owns: (report: KobraXReport) => boolean
    }
  >()
  /** When a request last ended without a result, by type and action. */
  const endedWithoutResult = new Map<string, number>()
  const routeKey = (type: string, action: string) => `${type}\0${action}`

  /** Acknowledgement on `<deviceId>/response`: "received" only. */
  function handleAck(payload: unknown) {
    const message = record(payload)
    if (typeof message.msgid !== 'string') return
    const code = message.code
    acks.get(message.msgid)?.(typeof code === 'number' ? code : undefined)
  }

  function isPending(report: KobraXReport) {
    return waiting.get(report.msgid)?.owns(report) === true
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
      issued.add(msgid)
      if (issued.size > issuedLimit)
        issued.delete(issued.values().next().value as string)
      waiting.set(msgid, {
        type: spec.type,
        action: spec.action,
        acked: false,
        owns: () => false,
      })
      // A late report of an earlier request on this route cannot be told
      // from this request's own, so this request gets no printer-assigned route.
      const key = routeKey(spec.type, spec.action)
      const earlier = endedWithoutResult.get(key)
      const lateRisk =
        earlier !== undefined && Date.now() - earlier < lateReportMs
      let acked = false
      let finished = false
      let timer: NodeJS.Timeout | undefined
      let stop: () => void = () => {}
      function finish(outcome: KobraXOutcome<T>) {
        if (finished) return
        finished = true
        clearTimeout(timer)
        acks.delete(msgid)
        waiting.delete(msgid)
        if (outcome.kind !== 'confirmed')
          endedWithoutResult.set(key, Date.now())
        stop()
        spec.signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      function onAbort() {
        finish(acked ? { kind: 'received' } : { kind: 'unanswered' })
      }
      // Exact: this request's own msgid with the right type and action. Only
      // this is evidence that the printer acted on this request.
      const ownsReport = (report: KobraXReport) =>
        report.msgid === msgid &&
        report.type === spec.type &&
        report.action === spec.action
      // Printer-assigned firmware gets the narrower route described on
      // `KobraXReportIdentity`. Such a report can settle the request but is
      // never evidence of an effect: `confirmed.correlated` stays false.
      const settlesReport = (report: KobraXReport) => {
        if (ownsReport(report)) return true
        if (report.type !== spec.type || report.action !== spec.action)
          return false
        if (!printerAssigned || !acked || lateRisk) return false
        if (report.msgid !== '' && issued.has(report.msgid)) return false
        let sharing = 0
        for (const other of waiting.values())
          if (other.type === spec.type && other.action === spec.action)
            sharing++
        return sharing === 1
      }
      stop = onReport((report) => {
        if (!settlesReport(report) || Number.isNaN(report.code)) return
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
          correlated: ownsReport(report),
          ...(spec.effect ? { effectMatches: spec.effect } : {}),
          data: (spec.result ? spec.result(report) : undefined) as T,
        })
      })
      const entry = waiting.get(msgid)
      if (entry) entry.owns = ownsReport
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
        const pending = waiting.get(msgid)
        if (pending) pending.acked = true
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

  return { send, handleAck, handleReport, isPending, onReport }
}
export type KobraXRequests = ReturnType<typeof createKobraXRequests>
