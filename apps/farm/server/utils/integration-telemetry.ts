import {
  HeartbeatHealth,
  PrinterState,
  PrinterTransition,
} from '@open3dfarmmanager/farm-protocol'
import { integrationGrantFor } from './integration-auth-http.ts'
import {
  uuidPattern,
  type IntegrationPrincipal,
  type IntegrationPrinterRow,
} from './integration-auth.ts'

export const MAX_HISTORY_WINDOW_MS = 7 * 86400_000
export const OBSERVATION_FRESH_MS = 120_000

export function projectTransitions(payloads: unknown[]) {
  const events = payloads.slice(0, 500).flatMap((payload) => {
    if (!payload || typeof payload !== 'object' || !('transition' in payload))
      return []
    const parsed = PrinterTransition.safeParse(payload.transition)
    return parsed.success
      ? [
          {
            observedAt: parsed.data.observedAt,
            from: parsed.data.from,
            to: parsed.data.to,
            ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
          },
        ]
      : []
  })
  return { events, eventsTruncated: payloads.length > 500 }
}

export function historyRange(query: URLSearchParams, now = Date.now()) {
  if (
    [...query.keys()].some((key) => !['since', 'until', 'limit'].includes(key))
  )
    return null
  if (['since', 'until', 'limit'].some((key) => query.getAll(key).length > 1))
    return null
  const untilText = query.get('until') ?? String(now)
  const sinceText =
    query.get('since') ?? String(Math.max(0, Number(untilText) - 86400_000))
  const limitText = query.get('limit') ?? '100'
  if (
    ![sinceText, untilText].every(
      (v) => /^(0|[1-9]\d{0,15})$/.test(v) && Number.isSafeInteger(Number(v)),
    ) ||
    !/^(?:[1-9]\d?|[1-4]\d\d|500)$/.test(limitText)
  )
    return null
  const since = Number(sinceText),
    until = Number(untilText),
    limit = Number(limitText)
  if (until <= since || until - since > MAX_HISTORY_WINDOW_MS || until > now)
    return null
  return { since, until, limit }
}

export function authorizedPrinter(
  principal: IntegrationPrincipal,
  row: IntegrationPrinterRow | null,
  id: string,
) {
  return uuidPattern.test(id) &&
    row &&
    row.id === id &&
    integrationGrantFor(principal, 'printers:read', row.farmId, row.id)
    ? row
    : null
}

export function authorizedPrinterForScope(
  principal: IntegrationPrincipal,
  row: IntegrationPrinterRow | null,
  id: string,
  scope: 'camera:view' | 'alerts:write',
) {
  return uuidPattern.test(id) &&
    row &&
    row.id === id &&
    integrationGrantFor(principal, scope, row.farmId, row.id)
    ? row
    : null
}

/** Whitelist observations; never return stored protocol payloads or local URLs. */
export function projectHistory(
  payloads: unknown[],
  since: number,
  until: number,
) {
  const states = payloads
    .flatMap((payload) => {
      if (!payload || typeof payload !== 'object' || !('state' in payload))
        return []
      const result = PrinterState.safeParse(payload.state)
      return result.success ? [result.data] : []
    })
    .sort((a, b) => a.observedAt - b.observedAt)
  const metrics = states
    .filter(
      (s) =>
        s.state !== 'offline' && s.observedAt >= since && s.observedAt < until,
    )
    .map((s) => ({
      observedAt: s.observedAt,
      ...(s.progress !== undefined
        ? { progress: { value: s.progress, unit: 'ratio' } }
        : {}),
      ...(s.toolTemperatureCelsius !== undefined
        ? { toolTemperature: { value: s.toolTemperatureCelsius, unit: '°C' } }
        : {}),
      ...(s.bedTemperatureCelsius !== undefined
        ? { bedTemperature: { value: s.bedTemperatureCelsius, unit: '°C' } }
        : {}),
      ...(s.fans?.chamber !== undefined
        ? { chamberFan: { value: s.fans.chamber, unit: '%' } }
        : {}),
      ...(s.toolTargetsCelsius === undefined
        ? {}
        : {
            toolTargets: s.toolTargetsCelsius.map(({ tool, target }) => ({
              tool,
              value: target,
              unit: '°C',
            })),
          }),
      ...(s.chamberTemperatureCelsius === undefined
        ? {}
        : {
            chamberTemperature: {
              value: s.chamberTemperatureCelsius,
              unit: '°C',
            },
          }),
      ...(s.chamberTargetCelsius === undefined
        ? {}
        : {
            chamberTarget: { value: s.chamberTargetCelsius, unit: '°C' },
          }),
      ...(s.runEnergyWh === undefined
        ? {}
        : {
            runEnergy: { value: s.runEnergyWh, unit: 'Wh' },
          }),
      ...(s.currentLayer !== undefined ? { currentLayer: s.currentLayer } : {}),
      ...(s.totalLayer !== undefined ? { totalLayer: s.totalLayer } : {}),
      ...(s.printDuration !== undefined
        ? { elapsed: { value: s.printDuration, unit: 's' } }
        : {}),
    }))
  const intervals = states
    .map((s, i) => ({
      from: Math.max(since, s.observedAt),
      until: Math.min(
        until,
        states[i + 1]?.observedAt ?? until,
        s.observedAt + OBSERVATION_FRESH_MS,
      ),
      state: s.state === 'offline' ? 'gap' : s.state,
    }))
    .filter((s) => s.until > s.from)
  const timeline: { from: number; until: number; state: string }[] = []
  let position = since
  for (const interval of intervals) {
    if (interval.from > position)
      timeline.push({ from: position, until: interval.from, state: 'gap' })
    const from = Math.max(position, interval.from)
    if (interval.until > from) timeline.push({ ...interval, from })
    position = Math.max(position, interval.until)
  }
  if (position < until) timeline.push({ from: position, until, state: 'gap' })
  return { metrics, intervals: timeline }
}

export function projectHealth(
  heartbeat: { lastSeenAt: number; health: unknown } | null,
  printerKey: string,
  now = Date.now(),
) {
  const parsed = HeartbeatHealth.safeParse(heartbeat?.health)
  const fresh =
    heartbeat !== null &&
    heartbeat.lastSeenAt <= now &&
    now - heartbeat.lastSeenAt <= OBSERVATION_FRESH_MS
  const printer = parsed.success
    ? parsed.data.printers.find((p) => p.printerKey === printerKey)
    : undefined
  const reasons: string[] = []
  if (!fresh) reasons.push('connector-stale')
  if (!parsed.success) reasons.push('health-unavailable')
  if (fresh && parsed.success && parsed.data.connector.rtcScope === 'disabled')
    reasons.push('rtc-disabled')
  if (parsed.success && parsed.data.connector.storage === 'degraded')
    reasons.push('storage-degraded')
  if (fresh && !printer) reasons.push('assignment-unreported')
  const assignmentObservedAt = printer?.lastSuccessAt
  const assignmentFresh =
    typeof assignmentObservedAt === 'number' &&
    assignmentObservedAt <= now &&
    now - assignmentObservedAt <= OBSERVATION_FRESH_MS
  if (fresh && printer && printer.state !== 'connected')
    reasons.push(`printer-${printer.state}`)
  if (fresh && printer?.state === 'connected' && !assignmentFresh)
    reasons.push('assignment-stale')
  return {
    connector: fresh ? 'connected' : 'unknown',
    assignment:
      fresh && printer && (printer.state !== 'connected' || assignmentFresh)
        ? printer.state
        : 'unknown',
    degraded: reasons.length > 0,
    reasons,
    ...(heartbeat ? { observedAt: heartbeat.lastSeenAt } : {}),
    ...(typeof assignmentObservedAt === 'number' && assignmentObservedAt <= now
      ? { assignmentObservedAt }
      : {}),
  }
}
