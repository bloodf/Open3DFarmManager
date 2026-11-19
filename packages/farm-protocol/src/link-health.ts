export const LINK_HEARTBEAT_INTERVAL_MS = 60_000

export interface PrinterLinkHealth {
  printerKey: string
  state: 'connected' | 'reconnecting' | 'offline'
  lastSuccessAt: number | null
  p50Ms: number | null
  p95Ms: number | null
  reconnects: number
  lastErrorCode: string | null
}

export interface ConnectorLinkHealth {
  version: string
  uptimeMs: number
  queueBacklog: number
  storage: 'healthy' | 'degraded'
  rtcScope: 'loopback' | 'lan' | 'disabled'
}

export interface LinkHealthFrame {
  kind: 'link-health-snapshot' | 'link-health-heartbeat'
  observedAt: number
  page: number
  pages: number
  connector: ConnectorLinkHealth
  printers: PrinterLinkHealth[]
}
