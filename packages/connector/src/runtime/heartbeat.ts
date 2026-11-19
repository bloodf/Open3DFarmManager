// SPDX-License-Identifier: MIT
/** Bounded Connector telemetry heartbeat (every 60 s) carrying link health. */

import { connectorVersionMetadata } from '../status/version.ts'
import {
  encodeLinkHealthSnapshot,
  LINK_HEALTH_FRAME_MAX_BYTES,
  type LinkHealthRegistry,
  type PrinterLinkHealth,
} from './link-health.ts'

export const HEARTBEAT_INTERVAL_MS = 60_000
export const HEARTBEAT_FRAME_MAX_BYTES = LINK_HEALTH_FRAME_MAX_BYTES

export type ConnectorStorageState = 'ok' | 'degraded'
export type ConnectorRtcScope = 'loopback' | 'lan'

export type ConnectorHeartbeat = Readonly<{
  t: 'connector-heartbeat'
  connectorVersion: string
  protocolRevision?: number
  uptimeMs: number
  queueBacklog: number
  storage: ConnectorStorageState
  rtcScope: ConnectorRtcScope
  printers: readonly PrinterLinkHealth[]
  observedAt: number
}>

/** Status-snapshot fields derived from the same heartbeat evidence. */
export type ConnectorStatusHealth = Readonly<{
  connectorVersion: string
  protocolRevision?: number
  uptimeMs: number
  queueBacklog: number
  storage: ConnectorStorageState
  rtcScope: ConnectorRtcScope
  printers: readonly PrinterLinkHealth[]
}>

export function encodeConnectorHeartbeat(
  heartbeat: ConnectorHeartbeat,
): string {
  if (heartbeat.t !== 'connector-heartbeat')
    throw new Error('Invalid connector heartbeat')
  if (
    !Number.isSafeInteger(heartbeat.uptimeMs) ||
    heartbeat.uptimeMs < 0 ||
    !Number.isSafeInteger(heartbeat.queueBacklog) ||
    heartbeat.queueBacklog < 0 ||
    (heartbeat.storage !== 'ok' && heartbeat.storage !== 'degraded') ||
    (heartbeat.rtcScope !== 'loopback' && heartbeat.rtcScope !== 'lan')
  )
    throw new Error('Invalid connector heartbeat fields')
  // Reuse the link-health frame bound: printers must encode within it, then the
  // full heartbeat envelope is checked against the same byte cap.
  encodeLinkHealthSnapshot({ printers: heartbeat.printers })
  const wire = JSON.stringify({
    t: heartbeat.t,
    connectorVersion: heartbeat.connectorVersion,
    ...(heartbeat.protocolRevision !== undefined
      ? { protocolRevision: heartbeat.protocolRevision }
      : {}),
    uptimeMs: heartbeat.uptimeMs,
    queueBacklog: heartbeat.queueBacklog,
    storage: heartbeat.storage,
    rtcScope: heartbeat.rtcScope,
    observedAt: heartbeat.observedAt,
    printers: heartbeat.printers.map((p) => {
      const row: Record<string, unknown> = {
        k: p.printerKey,
        s: p.link,
        r: p.reconnectsLastHour,
      }
      if (p.lastSuccessAt !== undefined) row.ls = p.lastSuccessAt
      if (p.rttP50Ms !== undefined) row.p50 = p.rttP50Ms
      if (p.rttP95Ms !== undefined) row.p95 = p.rttP95Ms
      if (p.lastErrorCode !== undefined) row.e = p.lastErrorCode
      return row
    }),
  })
  if (Buffer.byteLength(wire, 'utf8') > HEARTBEAT_FRAME_MAX_BYTES)
    throw new Error('Connector heartbeat frame limit')
  return wire
}

export function heartbeatWireBytes(heartbeat: ConnectorHeartbeat): number {
  return Buffer.byteLength(encodeConnectorHeartbeat(heartbeat), 'utf8')
}

export type ConnectorHeartbeatRuntime = Readonly<{
  /** Full heartbeat for the telemetry path. */
  snapshot(at?: number): ConnectorHeartbeat
  /** Same numbers for inclusion in a live status snapshot. */
  statusSnapshot(at?: number): ConnectorStatusHealth
  /** Encode and bound-check the telemetry heartbeat frame. */
  encode(at?: number): string
  start(): void
  stop(): void
  close(): void
}>

export function createConnectorHeartbeat(options: {
  links: LinkHealthRegistry
  /** Monotonic or wall start time in the same units as `now`. */
  startedAt: number
  now?: () => number
  queueBacklog?: () => number
  storage?: () => ConnectorStorageState
  rtcScope?: () => ConnectorRtcScope
  connectorVersion?: string
  protocolRevision?: number
  intervalMs?: number
  onHeartbeat?: (heartbeat: ConnectorHeartbeat, wire: string) => void
}): ConnectorHeartbeatRuntime {
  const nowFn = options.now ?? (() => Date.now())
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 3_600_000
  )
    throw new Error('Invalid heartbeat interval')
  if (!Number.isFinite(options.startedAt) || options.startedAt < 0)
    throw new Error('Invalid heartbeat start time')

  const version =
    options.connectorVersion ?? connectorVersionMetadata.connectorVersion
  const protocolRevision =
    options.protocolRevision ?? connectorVersionMetadata.protocolRevision
  const queueBacklog = options.queueBacklog ?? (() => 0)
  const storage = options.storage ?? (() => 'ok' as const)
  const rtcScope = options.rtcScope ?? (() => 'loopback' as const)

  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false

  function build(at?: number): ConnectorHeartbeat {
    if (closed) throw new Error('Connector heartbeat closed')
    const observedAt = at ?? nowFn()
    if (!Number.isFinite(observedAt) || observedAt < 0)
      throw new Error('Invalid heartbeat time')
    const uptimeMs = Math.max(0, Math.floor(observedAt - options.startedAt))
    const backlog = queueBacklog()
    if (!Number.isSafeInteger(backlog) || backlog < 0)
      throw new Error('Invalid queue backlog')
    const storageState = storage()
    const scope = rtcScope()
    const links = options.links.snapshot(observedAt)
    return {
      t: 'connector-heartbeat',
      connectorVersion: version,
      ...(protocolRevision !== undefined ? { protocolRevision } : {}),
      uptimeMs,
      queueBacklog: backlog,
      storage: storageState,
      rtcScope: scope,
      printers: links.printers,
      observedAt,
    }
  }

  function emit() {
    if (closed || !options.onHeartbeat) return
    const heartbeat = build()
    options.onHeartbeat(heartbeat, encodeConnectorHeartbeat(heartbeat))
  }

  return {
    snapshot(at) {
      return build(at)
    },
    statusSnapshot(at) {
      const heartbeat = build(at)
      return {
        connectorVersion: heartbeat.connectorVersion,
        ...(heartbeat.protocolRevision !== undefined
          ? { protocolRevision: heartbeat.protocolRevision }
          : {}),
        uptimeMs: heartbeat.uptimeMs,
        queueBacklog: heartbeat.queueBacklog,
        storage: heartbeat.storage,
        rtcScope: heartbeat.rtcScope,
        printers: heartbeat.printers,
      }
    },
    encode(at) {
      return encodeConnectorHeartbeat(build(at))
    },
    start() {
      if (closed) throw new Error('Connector heartbeat closed')
      if (timer) return
      timer = setInterval(emit, intervalMs)
      // Unref so a quiet heartbeat never keeps the process alive alone.
      timer.unref?.()
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = undefined
    },
    close() {
      closed = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },
  }
}
