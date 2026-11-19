// SPDX-License-Identifier: MIT

/** Mirrors the response of GET /api/farms/:farmId/network (server projection). */
export interface NetworkConnector {
  agentId: string
  fingerprint: string
  status: 'pending' | 'approved' | 'revoked'
  lastSeenAt: number | null
  health: { version: string; storage: 'healthy' | 'degraded' } | null
}
export interface NetworkPrinter {
  assignmentId: string
  agentId: string
  printerKey: string
  displayName: string | null
  link: {
    state: 'connected' | 'reconnecting' | 'offline'
    lastSuccessAt: number | null
    p50Ms: number | null
    p95Ms: number | null
  } | null
}
export interface NetworkDiscovered {
  agentId: string
  vendor: string
  model?: string | null
  name?: string | null
  host?: string
  port?: number | null
  serial?: string | null
  adopted: boolean
  lastSeen: number
}
export interface NetworkData {
  canManage?: boolean
  connectors: readonly NetworkConnector[]
  printers: readonly NetworkPrinter[]
  discovered: readonly NetworkDiscovered[]
}

export type NetworkStatus =
  | 'connected'
  | 'degraded'
  | 'reconnecting'
  | 'offline'
  | 'pending'
  | 'discovered'

/** Text, a glyph and a stroke pattern per status, so colour is never the only cue. */
export const statusInfo: Record<
  NetworkStatus,
  { label: string; glyph: string; dash: string; tone: string }
> = {
  connected: {
    label: 'Conectado',
    glyph: '✓',
    dash: '',
    tone: 'var(--printer-idle)',
  },
  degraded: {
    label: 'Degradado',
    glyph: '!',
    dash: '8 3 2 3',
    tone: 'var(--printer-paused)',
  },
  reconnecting: {
    label: 'Reconectando',
    glyph: '↻',
    dash: '8 4',
    tone: 'var(--printer-stale)',
  },
  offline: {
    label: 'Offline',
    glyph: '×',
    dash: '2 4',
    tone: 'var(--printer-error)',
  },
  pending: {
    label: 'Pendente',
    glyph: '…',
    dash: '2 4',
    tone: 'var(--printer-offline)',
  },
  discovered: {
    label: 'Descoberta',
    glyph: '?',
    dash: '4 4',
    tone: 'var(--printer-offline)',
  },
}

/** A Connector that has not reported for this long is treated as silent. */
export const CONNECTOR_SILENT_MS = 90_000

export interface NetworkEntry {
  id: string
  kind: 'connector' | 'printer' | 'discovered'
  agentId: string
  connectorName: string
  name: string
  status: NetworkStatus
  /** Status text, more specific than the status label when the cause is known. */
  statusText: string
  latencyMs: number | null
  p95Ms: number | null
  lastSeenAt: number | null
  href: string | null
  discovery?: NetworkDiscovered
}

export interface LiveOverlay {
  /** Connectors with an authenticated direct connection from this browser. */
  agents?: ReadonlySet<string>
  /** `${agentId}:${printerKey}` -> latest direct observation. */
  printers?: ReadonlyMap<
    string,
    { online: boolean; at: number; link?: NetworkPrinter['link'] }
  >
  now: number
}

export const printerOverlayKey = (agentId: string, printerKey: string) =>
  `${agentId}:${printerKey}`

export function connectorName(agentId: string) {
  return `Connector ${agentId.slice(0, 8)}`
}

export function formatAge(now: number, at: number | null) {
  if (at === null) return 'nunca'
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 5) return 'agora'
  if (seconds < 60) return `há ${seconds} s`
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`
  if (seconds < 86_400) return `há ${Math.floor(seconds / 3600)} h`
  return `há ${Math.floor(seconds / 86_400)} d`
}

export const formatLatency = (ms: number | null) =>
  ms === null ? '—' : `${Math.round(ms)} ms`

function connectorStatus(
  connector: NetworkConnector,
  now: number,
  live: boolean,
): Pick<NetworkEntry, 'status' | 'statusText' | 'lastSeenAt'> {
  if (connector.status === 'pending')
    return {
      status: 'pending',
      statusText: 'Aguardando aprovação',
      lastSeenAt: connector.lastSeenAt,
    }
  if (connector.status === 'revoked')
    return {
      status: 'offline',
      statusText: 'Revogado',
      lastSeenAt: connector.lastSeenAt,
    }
  if (live)
    return { status: 'connected', statusText: 'Conectado', lastSeenAt: now }
  const seen = connector.lastSeenAt
  if (seen === null)
    return { status: 'offline', statusText: 'Nunca visto', lastSeenAt: null }
  if (now - seen > CONNECTOR_SILENT_MS)
    return { status: 'offline', statusText: 'Sem sinal', lastSeenAt: seen }
  if (connector.health?.storage === 'degraded')
    return {
      status: 'degraded',
      statusText: 'Armazenamento degradado',
      lastSeenAt: seen,
    }
  return { status: 'connected', statusText: 'Conectado', lastSeenAt: seen }
}

/** Flattens the server read model, with any live overlay, into one list for the map and the table. */
export function buildEntries(
  data: NetworkData,
  overlay: LiveOverlay,
): NetworkEntry[] {
  const { now } = overlay
  const connectors = new Map<string, NetworkEntry>()
  for (const connector of data.connectors) {
    const status = connectorStatus(
      connector,
      now,
      overlay.agents?.has(connector.agentId) ?? false,
    )
    connectors.set(connector.agentId, {
      id: `connector:${connector.agentId}`,
      kind: 'connector',
      agentId: connector.agentId,
      connectorName: connectorName(connector.agentId),
      name: connectorName(connector.agentId),
      ...status,
      latencyMs: null,
      p95Ms: null,
      href: null,
    })
  }
  const entries = [...connectors.values()]
  for (const printer of data.printers) {
    const parent = connectors.get(printer.agentId)
    if (!parent) continue
    const live = overlay.printers?.get(
      printerOverlayKey(printer.agentId, printer.printerKey),
    )
    const link = live?.link ?? printer.link
    let status: NetworkStatus
    let statusText: string
    let lastSeenAt: number | null
    if (live) {
      status = !live.online
        ? 'offline'
        : live.link?.state === 'reconnecting'
          ? 'reconnecting'
          : 'connected'
      statusText = statusInfo[status].label
      lastSeenAt = live.link?.lastSuccessAt ?? live.at
    } else if (parent.status === 'offline' || parent.status === 'pending') {
      status = 'offline'
      statusText = `${parent.statusText} (Connector)`
      lastSeenAt = link?.lastSuccessAt ?? null
    } else if (!link) {
      status = 'offline'
      statusText = 'Sem relatório do Connector'
      lastSeenAt = null
    } else {
      status = link.state
      statusText = statusInfo[link.state].label
      lastSeenAt = link.lastSuccessAt
    }
    entries.push({
      id: `printer:${printer.assignmentId}`,
      kind: 'printer',
      agentId: printer.agentId,
      connectorName: parent.name,
      name: printer.displayName ?? printer.printerKey,
      status,
      statusText,
      latencyMs: link?.p50Ms ?? null,
      p95Ms: link?.p95Ms ?? null,
      lastSeenAt,
      href: `/impressoras/${encodeURIComponent(printer.printerKey)}`,
    })
  }
  data.discovered.forEach((found, index) => {
    const parent = connectors.get(found.agentId)
    if (!parent || found.adopted) return
    entries.push({
      id: `discovered:${found.agentId}:${index}`,
      kind: 'discovered',
      agentId: found.agentId,
      connectorName: parent.name,
      name: found.name || found.model || found.vendor,
      status: 'discovered',
      discovery: found,
      statusText: 'Descoberta',
      latencyMs: null,
      p95Ms: null,
      lastSeenAt: found.lastSeen,
      href: null,
    })
  })
  return entries
}

export interface NetworkFilter {
  agentId: string
  status: NetworkStatus | 'all'
}
export const noFilter: NetworkFilter = { agentId: 'all', status: 'all' }

/** Keeps the entries that match; a Connector stays when one of its printers matches. */
export function filterEntries(
  entries: readonly NetworkEntry[],
  filter: NetworkFilter,
): NetworkEntry[] {
  const inScope = entries.filter(
    (entry) => filter.agentId === 'all' || entry.agentId === filter.agentId,
  )
  if (filter.status === 'all') return inScope
  const matching = inScope.filter((entry) => entry.status === filter.status)
  const parents = new Set(matching.map((entry) => entry.agentId))
  return inScope.filter(
    (entry) =>
      entry.status === filter.status ||
      (entry.kind === 'connector' && parents.has(entry.agentId)),
  )
}

/** Table first on narrow screens, map from tablet width up. */
export const MAP_MIN_WIDTH_PX = 768
export const defaultView = (width: number): 'map' | 'table' =>
  width >= MAP_MIN_WIDTH_PX ? 'map' : 'table'

export const COLUMN_WIDTH = 190
const SERVER_Y = 20
const CONNECTOR_Y = 110
const PRINTER_Y = 200
const ROW_HEIGHT = 64
const NODE_HEIGHT = 40

export interface MapNode {
  entry: NetworkEntry
  x: number
  y: number
  width: number
  height: number
  /** Where the link to the parent ends, on this node. */
  linkX: number
  linkY: number
  /** Where the link starts, on the parent. */
  fromX: number
  fromY: number
  labelY: number
}
export interface MapLayout {
  width: number
  height: number
  server: { x: number; y: number; width: number; height: number }
  nodes: MapNode[]
}

/** Server on top, one column per Connector, its printers stacked beneath. */
export function layoutMap(entries: readonly NetworkEntry[]): MapLayout {
  const connectors = entries.filter((entry) => entry.kind === 'connector')
  const width = Math.max(connectors.length, 1) * COLUMN_WIDTH
  const server = { x: width / 2 - 70, y: SERVER_Y, width: 140, height: 36 }
  const nodes: MapNode[] = []
  let height = CONNECTOR_Y + NODE_HEIGHT + 20
  connectors.forEach((connector, column) => {
    const left = column * COLUMN_WIDTH
    const x = left + 8
    nodes.push({
      entry: connector,
      x,
      y: CONNECTOR_Y,
      width: COLUMN_WIDTH - 16,
      height: NODE_HEIGHT,
      linkX: x + (COLUMN_WIDTH - 16) / 2,
      linkY: CONNECTOR_Y,
      fromX: width / 2,
      fromY: server.y + server.height,
      labelY: CONNECTOR_Y - 10,
    })
    entries
      .filter(
        (entry) =>
          entry.kind !== 'connector' && entry.agentId === connector.agentId,
      )
      .forEach((child, row) => {
        const rowY = PRINTER_Y + row * ROW_HEIGHT
        const nodeY = rowY + 16
        nodes.push({
          entry: child,
          x: left + 28,
          y: nodeY,
          width: COLUMN_WIDTH - 40,
          height: NODE_HEIGHT,
          linkX: left + 28,
          linkY: nodeY + NODE_HEIGHT / 2,
          fromX: left + 18,
          fromY: CONNECTOR_Y + NODE_HEIGHT,
          labelY: rowY + 10,
        })
        height = Math.max(height, nodeY + NODE_HEIGHT + 20)
      })
  })
  return { width, height, server, nodes }
}
