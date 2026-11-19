import type { Sql } from 'postgres'

/** Library quota: per-farm for the server disk, per-Connector for Connector mode. */
export type StorageMode = 'server' | 'connector'

export const DEFAULT_QUOTA_BYTES = 21_474_836_480 // 20 GiB, per #378
export const QUOTA_ENV = 'OPENFARM_LIBRARY_QUOTA_BYTES'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Default for farms with no stored setting. `OPENFARM_LIBRARY_QUOTA_BYTES` overrides 20 GiB. */
export function defaultQuotaBytes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[QUOTA_ENV]
  if (raw === undefined || raw === '') return DEFAULT_QUOTA_BYTES
  const bytes = Number(raw)
  if (!/^[0-9]{1,16}$/.test(raw) || !Number.isSafeInteger(bytes))
    throw new Error(`${QUOTA_ENV} must be a whole number of bytes`)
  return bytes
}

export interface QuotaBasis {
  usedBytes: number
  quotaBytes: number
}
export type QuotaDecision =
  | { ok: true }
  | {
      ok: false
      reason: 'quota-exceeded'
      /** Accessible pt-BR text, safe to show to the user. */
      message: string
      availableBytes: number
    }

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${UNITS[unit]}`
}

/** Refuses an upload that would not fit. Existing content never counts again (dedupe is checked by the caller). */
export function checkQuota(
  mode: StorageMode,
  basis: QuotaBasis,
  incomingBytes: number,
): QuotaDecision {
  const availableBytes = Math.max(0, basis.quotaBytes - basis.usedBytes)
  if (incomingBytes <= availableBytes) return { ok: true }
  const where = mode === 'server' ? 'no servidor' : 'no computador do Conector'
  return {
    ok: false,
    reason: 'quota-exceeded',
    availableBytes,
    message: `Cota da biblioteca excedida ${where}: o envio precisa de ${formatBytes(incomingBytes)}, mas há ${formatBytes(availableBytes)} livres de ${formatBytes(basis.quotaBytes)}. Remova versões antigas ou aumente a cota.`,
  }
}

export interface ConnectorStorage extends QuotaBasis {
  agentId: string
  availableBytes: number
  reportedAt: number
}
export interface StorageUsage extends QuotaBasis {
  /** The farm's active mode: the figures below describe this location. */
  mode: StorageMode
  availableBytes: number
  /** Connector mode only: per-Connector figures as last reported by each host. */
  connectors: ConnectorStorage[]
  /** Connector mode and no Connector has reported yet. */
  unreported: boolean
}

type ReportRow = Pick<
  ConnectorStorage,
  'agentId' | 'usedBytes' | 'quotaBytes' | 'reportedAt'
>

export function summarizeUsage(
  mode: StorageMode,
  server: QuotaBasis,
  reports: readonly ReportRow[],
): StorageUsage {
  if (mode === 'server')
    return {
      mode,
      ...server,
      availableBytes: Math.max(0, server.quotaBytes - server.usedBytes),
      connectors: [],
      unreported: false,
    }
  const connectors = reports.map((report) => ({
    ...report,
    availableBytes: Math.max(0, report.quotaBytes - report.usedBytes),
  }))
  const usedBytes = connectors.reduce((sum, c) => sum + c.usedBytes, 0)
  const quotaBytes = connectors.reduce((sum, c) => sum + c.quotaBytes, 0)
  return {
    mode,
    usedBytes,
    quotaBytes,
    availableBytes: connectors.reduce((sum, c) => sum + c.availableBytes, 0),
    connectors,
    unreported: connectors.length === 0,
  }
}

export function describeUsage(usage: StorageUsage): string {
  if (usage.unreported)
    return 'O Conector ainda não informou o espaço da biblioteca.'
  return `${formatBytes(usage.usedBytes)} usados de ${formatBytes(usage.quotaBytes)} (${formatBytes(usage.availableBytes)} livres)`
}

export async function serverUsedBytes(
  tx: Sql,
  farmId: string,
): Promise<number> {
  const rows = await tx<
    { used: number }[]
  >`SELECT COALESCE(sum(size_bytes), 0)::float8 AS used FROM farm.library_blobs WHERE farm_id=${farmId}::uuid AND storage_location='server' AND purged_at IS NULL`
  return rows[0]?.used ?? 0
}

export function connectorReports(tx: Sql, farmId: string) {
  return tx<
    ReportRow[]
  >`SELECT agent_id AS "agentId", used_bytes::float8 AS "usedBytes", quota_bytes::float8 AS "quotaBytes", reported_at::float8 AS "reportedAt" FROM farm.library_connector_storage WHERE farm_id=${farmId}::uuid ORDER BY agent_id`
}

/**
 * What an upload must fit in. Connector mode trusts the host's own report;
 * without one the Connector still enforces its quota and refuses by itself.
 */
export async function quotaBasis(
  tx: Sql,
  farmId: string,
  location: StorageMode,
  agentId: string | undefined,
  serverQuotaBytes: number,
): Promise<QuotaBasis | null> {
  if (location === 'server')
    return {
      usedBytes: await serverUsedBytes(tx, farmId),
      quotaBytes: serverQuotaBytes,
    }
  const rows = await tx<
    QuotaBasis[]
  >`SELECT used_bytes::float8 AS "usedBytes", quota_bytes::float8 AS "quotaBytes" FROM farm.library_connector_storage WHERE farm_id=${farmId}::uuid AND agent_id=${agentId!}::uuid`
  return rows[0] ?? null
}

export interface ConnectorStorageReport {
  farmId: string
  agentId: string
  quotaBytes: number
  usedBytes: number
}

/**
 * Stores what a Connector host says about its library directory. The caller has
 * already authenticated the Connector credential for `agentId`; this only
 * checks that the agent is an approved Connector of the farm.
 */
export async function recordConnectorStorage(
  sql: Sql,
  report: ConnectorStorageReport,
  now: number = Date.now(),
): Promise<
  { ok: true } | { ok: false; reason: 'invalid-input' | 'forbidden' }
> {
  const valid = (n: number) => Number.isSafeInteger(n) && n >= 0
  if (
    !uuid.test(report.farmId) ||
    !uuid.test(report.agentId) ||
    !valid(report.quotaBytes) ||
    !valid(report.usedBytes)
  )
    return { ok: false, reason: 'invalid-input' }
  return sql.begin(async (tx) => {
    const enrolled =
      await tx`SELECT 1 FROM farm.connector_enrollments WHERE farm_id=${report.farmId}::uuid AND agent_id=${report.agentId}::uuid AND status='approved' FOR SHARE`
    if (!enrolled[0])
      return { ok: false as const, reason: 'forbidden' as const }
    await tx`INSERT INTO farm.library_connector_storage (farm_id, agent_id, quota_bytes, used_bytes, reported_at)
      VALUES (${report.farmId}::uuid, ${report.agentId}::uuid, ${report.quotaBytes}, ${report.usedBytes}, ${now})
      ON CONFLICT (farm_id, agent_id) DO UPDATE SET quota_bytes=EXCLUDED.quota_bytes, used_bytes=EXCLUDED.used_bytes, reported_at=EXCLUDED.reported_at`
    return { ok: true as const }
  })
}
