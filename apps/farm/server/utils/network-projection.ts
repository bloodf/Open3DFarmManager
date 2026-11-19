// Namespace import: the name is both a value and a type in farm-protocol, and the test transform drops a named import.
import * as protocol from '@open3dfarmmanager/farm-protocol'

/** Mirrors the Connector heartbeat document (farm-protocol link-health). */
interface ConnectorHealth {
  version: string
  uptimeMs: number
  queueBacklog: number
  storage: 'healthy' | 'degraded'
  rtcScope: 'loopback' | 'lan' | 'disabled'
}
interface PrinterLink {
  state: 'connected' | 'reconnecting' | 'offline'
  lastSuccessAt: number | null
  p50Ms: number | null
  p95Ms: number | null
  reconnects: number
  lastErrorCode: string | null
}

export type FarmRole = 'owner' | 'admin' | 'operator' | 'viewer'

export interface NetworkConnectorRow {
  agentId: string
  fingerprint: string
  status: 'pending' | 'approved' | 'revoked'
  lastSeenAt: number | null
  health: unknown
}
export interface NetworkPrinterRow {
  assignmentId: string
  agentId: string
  printerKey: string
  displayName: string | null
}
export interface NetworkDiscoveryRow {
  agentId: string
  observedAt: number
  printers: unknown
}
export interface NetworkRows {
  role: FarmRole
  connectors: NetworkConnectorRow[]
  printers: NetworkPrinterRow[]
  discoveries: NetworkDiscoveryRow[]
}

/** Address-level detail (host, port, serial) is only for people who manage the farm. */
export const canSeeAddresses = (role: FarmRole) =>
  role === 'owner' || role === 'admin'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const oneOf = <T extends string>(value: unknown, options: readonly T[]) =>
  options.find((option) => option === value) ?? null

/** Stored health is never trusted: only known fields survive, anything else is dropped. */
function parseConnectorHealth(health: unknown): {
  connector: ConnectorHealth | null
  printers: Map<string, PrinterLink>
} {
  const printers = new Map<string, PrinterLink>()
  if (!isObject(health)) return { connector: null, printers }
  const connector = isObject(health.connector) ? health.connector : {}
  const storage = oneOf(connector.storage, ['healthy', 'degraded'] as const)
  const rtcScope = oneOf(connector.rtcScope, [
    'loopback',
    'lan',
    'disabled',
  ] as const)
  const parsed =
    typeof connector.version === 'string' &&
    num(connector.uptimeMs) !== null &&
    num(connector.queueBacklog) !== null &&
    storage &&
    rtcScope
      ? {
          version: connector.version.slice(0, 64),
          uptimeMs: connector.uptimeMs as number,
          queueBacklog: connector.queueBacklog as number,
          storage,
          rtcScope,
        }
      : null
  if (Array.isArray(health.printers))
    for (const item of health.printers.slice(0, 100)) {
      if (!isObject(item) || typeof item.printerKey !== 'string') continue
      const state = oneOf(item.state, [
        'connected',
        'reconnecting',
        'offline',
      ] as const)
      if (!state) continue
      printers.set(item.printerKey, {
        state,
        lastSuccessAt: num(item.lastSuccessAt),
        p50Ms: num(item.p50Ms),
        p95Ms: num(item.p95Ms),
        reconnects: num(item.reconnects) ?? 0,
        lastErrorCode:
          typeof item.lastErrorCode === 'string'
            ? item.lastErrorCode.slice(0, 64)
            : null,
      })
    }
  return { connector: parsed, printers }
}

/** The network read model for one farm, shaped for the caller's role. */
export function projectNetwork(rows: NetworkRows) {
  const addresses = canSeeAddresses(rows.role)
  const healthByAgent = new Map(
    rows.connectors.map((row) => [
      row.agentId,
      parseConnectorHealth(row.health),
    ]),
  )
  return {
    connectors: rows.connectors.map((row) => ({
      agentId: row.agentId,
      fingerprint: row.fingerprint,
      status: row.status,
      lastSeenAt: row.lastSeenAt,
      health: healthByAgent.get(row.agentId)?.connector ?? null,
    })),
    printers: rows.printers.map((row) => ({
      assignmentId: row.assignmentId,
      agentId: row.agentId,
      printerKey: row.printerKey,
      displayName: row.displayName,
      link:
        healthByAgent.get(row.agentId)?.printers.get(row.printerKey) ?? null,
    })),
    discovered: rows.discoveries.flatMap((row) => {
      const parsed = protocol.DiscoveryResults.safeParse(row.printers)
      if (!parsed.success) return []
      return parsed.data.map((printer) => ({
        agentId: row.agentId,
        vendor: printer.vendor,
        model: printer.model,
        name: printer.name,
        adopted: printer.adopted,
        firstSeen: printer.firstSeen,
        lastSeen: printer.lastSeen,
        ...(addresses && {
          host: printer.host,
          port: printer.port,
          serial: printer.serial ?? null,
        }),
      }))
    }),
  }
}
export type NetworkProjection = ReturnType<typeof projectNetwork>
