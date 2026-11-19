import type { Sql } from 'postgres'
import type { BlobStore } from './blob-store.ts'

/**
 * Library retention job (#378), run next to the telemetry prune with its own
 * database role (migration 0057). Per run:
 *  1. keep the newest N live versions per item when the owner set N (older ones
 *     are soft-deleted, never purged on the spot);
 *  2. purge blobs whose every version was soft-deleted for `retentionDays`
 *     (default 30), plus blobs no version references;
 *  3. sweep stored files no blob row references (server disk, or the Connector
 *     host in Connector mode).
 * A blob is marked purged and its file removed in one transaction under the
 * farm's upload lock; if removal fails the mark rolls back and a later run retries.
 */
const DAY_MS = 86_400_000
/** Files and rows younger than this may belong to an upload still in flight. */
export const ORPHAN_GRACE_MS = 3_600_000
export const DEFAULT_RETENTION_DAYS = 30
/** Shown for a replay of a version whose file was purged. */
export const PURGED_LABEL = 'arquivo removido'

export type ReplayAvailability =
  { available: true } | { available: false; label: typeof PURGED_LABEL }

export function replayAvailability(version: {
  purgedAt: number | null
}): ReplayAvailability {
  return version.purgedAt === null
    ? { available: true }
    : { available: false, label: PURGED_LABEL }
}

export interface BlobFacts {
  farmId: string
  sha256: string
  sizeBytes: number
  location: 'server' | 'connector'
  agentId: string | null
  createdAt: number
  retentionDays: number
  /** Versions pointing at this blob, deleted or not. */
  refs: number
  /** At least one referencing version is not soft-deleted. */
  live: boolean
  newestDeletedAt: number | null
}

/** Authoritative purge rule; the SQL prefilter below mirrors it. */
export function isPurgeable(
  facts: BlobFacts,
  now: number,
  graceMs: number = ORPHAN_GRACE_MS,
): boolean {
  if (facts.live) return false
  if (facts.refs === 0) return now - facts.createdAt >= graceMs
  return (
    facts.newestDeletedAt !== null &&
    facts.newestDeletedAt <= now - facts.retentionDays * DAY_MS
  )
}

/**
 * The Connector side of retention. The Connector host enforces it on its own
 * disk and answers with what it actually removed (an absent file counts as removed).
 */
export interface ConnectorLibraryPort {
  purge(agentId: string, sha256s: readonly string[]): Promise<string[]>
  /** Removes stored files not in `referenced` (the Connector skips files younger than its own grace). */
  sweep(agentId: string, referenced: readonly string[]): Promise<string[]>
}

export interface RetentionDeps {
  sql: Sql
  /** Server disk; without it server-mode blobs are deferred. */
  blobs?: BlobStore
  /** Connector transport; without it Connector-mode blobs are deferred. */
  connectors?: ConnectorLibraryPort
  clock?: () => number
}
export interface RetentionConfig {
  batchSize: number
  graceMs?: number
}
export interface RetentionResult {
  versionsTrimmed: number
  blobsPurged: number
  bytesFreed: number
  serverFilesSwept: number
  connectorFilesSwept: number
  /** Purgeable now but the server disk or Connector transport is not available to this run. */
  deferred: number
  failed: number
}

type Facts = (
  tx: Sql,
  scope: {
    farmId: string
    sha256: string
    location: BlobFacts['location']
    agentId: string | null
  },
) => Promise<BlobFacts[]>

const FACT_COLUMNS = (
  tx: Sql,
) => tx`SELECT b.farm_id AS "farmId", b.sha256, b.size_bytes::float8 AS "sizeBytes",
  b.storage_location AS "location", b.agent_id AS "agentId", b.created_at::float8 AS "createdAt",
  COALESCE(s.retention_days, ${DEFAULT_RETENTION_DAYS})::int AS "retentionDays",
  count(v.id)::int AS refs, COALESCE(bool_or(v.deleted_at IS NULL), false) AS live,
  max(v.deleted_at)::float8 AS "newestDeletedAt"
  FROM farm.library_blobs b
  LEFT JOIN farm.library_settings s ON s.farm_id = b.farm_id
  LEFT JOIN farm.library_versions v ON v.farm_id = b.farm_id AND v.sha256 = b.sha256 AND v.storage_location = b.storage_location AND v.location_agent_id = b.location_agent_id`
const FACT_GROUP = (tx: Sql) =>
  tx`GROUP BY b.farm_id, b.sha256, b.size_bytes, b.storage_location, b.agent_id, b.created_at, s.retention_days`

const factsOf: Facts = (tx, scope) =>
  tx<
    BlobFacts[]
  >`${FACT_COLUMNS(tx)} WHERE b.farm_id=${scope.farmId}::uuid AND b.sha256=${scope.sha256} AND b.storage_location=${scope.location} AND b.agent_id IS NOT DISTINCT FROM ${scope.agentId}::uuid AND b.purged_at IS NULL ${FACT_GROUP(tx)}`

/** Same rule as isPurgeable, so each batch holds only blobs that can go (no starvation by live ones). */
function purgeCandidates(
  sql: Sql,
  now: number,
  graceMs: number,
  limit: number,
) {
  return sql<
    BlobFacts[]
  >`${FACT_COLUMNS(sql)} WHERE b.purged_at IS NULL ${FACT_GROUP(sql)}
  HAVING bool_or(v.deleted_at IS NULL) IS NOT TRUE AND (
    (count(v.id) = 0 AND b.created_at <= ${now - graceMs})
    OR max(v.deleted_at) <= ${now} - COALESCE(s.retention_days, ${DEFAULT_RETENTION_DAYS})::bigint * ${DAY_MS})
  ORDER BY b.created_at LIMIT ${limit}`
}

/** Soft-deletes live versions beyond the owner's "keep newest N" (purge happens after the retention window). */
async function trimVersions(sql: Sql, now: number, limit: number) {
  const rows = await sql`UPDATE farm.library_versions v SET deleted_at=${now}
    WHERE v.id IN (
      SELECT old.id FROM farm.library_versions old
      JOIN farm.library_settings s ON s.farm_id = old.farm_id AND s.keep_versions IS NOT NULL
      WHERE old.deleted_at IS NULL AND (
        SELECT count(*) FROM farm.library_versions newer
        WHERE newer.item_id = old.item_id AND newer.deleted_at IS NULL AND newer.version_number > old.version_number
      ) >= s.keep_versions
      ORDER BY old.created_at LIMIT ${limit})
    RETURNING v.id`
  return rows.length
}

async function removeStoredFile(
  tx: Sql,
  deps: RetentionDeps,
  facts: BlobFacts,
): Promise<void> {
  if (facts.location === 'connector') {
    const removed = await deps.connectors!.purge(facts.agentId!, [facts.sha256])
    if (!removed.includes(facts.sha256))
      throw new Error('Connector did not confirm the purge')
    return
  }
  // One file per hash is shared by every farm: keep it while another farm still uses it.
  const shared =
    await tx`SELECT 1 FROM farm.library_blobs WHERE sha256=${facts.sha256} AND storage_location='server' AND purged_at IS NULL LIMIT 1`
  // ponytail: a concurrent upload of the same bytes by another farm can race this delete; it must re-upload.
  if (!shared[0]) await deps.blobs!.remove(facts.sha256)
}

async function purgeOne(
  deps: RetentionDeps,
  facts: BlobFacts,
  now: number,
  graceMs: number,
): Promise<boolean> {
  return deps.sql.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '5000ms'`
    await tx`SET LOCAL lock_timeout = '2000ms'`
    // Same lock addVersion takes: a repeat upload cannot slip in between the check and the purge.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'library:' + facts.farmId}, 0))`
    const [fresh] = await factsOf(tx as unknown as Sql, facts)
    if (!fresh || !isPurgeable(fresh, now, graceMs)) return false
    const marked =
      await tx`UPDATE farm.library_blobs SET purged_at=${now} WHERE farm_id=${fresh.farmId}::uuid AND sha256=${fresh.sha256} AND storage_location=${fresh.location} AND agent_id IS NOT DISTINCT FROM ${fresh.agentId}::uuid AND purged_at IS NULL RETURNING 1`
    if (!marked[0]) return false
    await removeStoredFile(tx as unknown as Sql, deps, fresh)
    return true
  })
}

async function sweepServer(
  deps: RetentionDeps,
  now: number,
  graceMs: number,
): Promise<number> {
  const stale = (await deps.blobs!.list()).filter(
    (file) => now - file.mtimeMs >= graceMs,
  )
  let removed = 0
  for (let i = 0; i < stale.length; i += 500) {
    const chunk = stale.slice(i, i + 500).map((file) => file.sha256)
    const known = new Set(
      (
        await deps.sql<
          { sha256: string }[]
        >`SELECT DISTINCT sha256 FROM farm.library_blobs WHERE sha256 = ANY(${chunk}::text[]) AND storage_location='server' AND purged_at IS NULL`
      ).map((row) => row.sha256),
    )
    for (const sha256 of chunk)
      if (!known.has(sha256) && (await deps.blobs!.remove(sha256))) removed++
  }
  return removed
}

async function sweepConnectors(deps: RetentionDeps): Promise<number> {
  const hosts = await deps.sql<
    { agentId: string }[]
  >`SELECT DISTINCT agent_id AS "agentId" FROM farm.library_blobs WHERE storage_location='connector'`
  let removed = 0
  for (const { agentId } of hosts) {
    const referenced = await deps.sql<
      { sha256: string }[]
    >`SELECT sha256 FROM farm.library_blobs WHERE agent_id=${agentId}::uuid AND purged_at IS NULL`
    removed += (
      await deps.connectors!.sweep(
        agentId,
        referenced.map((row) => row.sha256),
      )
    ).length
  }
  return removed
}

export async function runLibraryRetention(
  deps: RetentionDeps,
  config: RetentionConfig,
): Promise<RetentionResult> {
  const now = (deps.clock ?? Date.now)()
  const graceMs = config.graceMs ?? ORPHAN_GRACE_MS
  const result = {
    versionsTrimmed: 0,
    blobsPurged: 0,
    bytesFreed: 0,
    serverFilesSwept: 0,
    connectorFilesSwept: 0,
    deferred: 0,
    failed: 0,
  }
  const guarded = async (step: () => Promise<void>) => {
    try {
      await step()
    } catch {
      result.failed++
    }
  }

  await guarded(async () => {
    result.versionsTrimmed = await trimVersions(deps.sql, now, config.batchSize)
  })
  await guarded(async () => {
    const candidates = await purgeCandidates(
      deps.sql,
      now,
      graceMs,
      config.batchSize,
    )
    for (const facts of candidates) {
      if (!isPurgeable(facts, now, graceMs)) continue
      if (facts.location === 'server' ? !deps.blobs : !deps.connectors) {
        result.deferred++
        continue
      }
      await guarded(async () => {
        if (await purgeOne(deps, facts, now, graceMs)) {
          result.blobsPurged++
          result.bytesFreed += facts.sizeBytes
        }
      })
    }
  })
  if (deps.blobs)
    await guarded(async () => {
      result.serverFilesSwept = await sweepServer(deps, now, graceMs)
    })
  if (deps.connectors)
    await guarded(async () => {
      result.connectorFilesSwept = await sweepConnectors(deps)
    })
  return result
}

export type LibraryRetentionRuntimeConfig = Readonly<
  RetentionConfig & { databaseUrl: string; intervalMs: number }
>

export function parseLibraryRetentionConfig(
  value: unknown,
): LibraryRetentionRuntimeConfig | undefined {
  if (!value || typeof value !== 'object') return
  const input = value as Record<string, unknown>
  if (input.enabled !== true) return
  const { databaseUrl } = input
  const intervalMs = input.intervalMs ?? 3_600_000
  const batchSize = input.batchSize ?? 100
  if (typeof databaseUrl !== 'string' || !databaseUrl)
    throw new Error('Invalid library retention database URL')
  if (!['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol))
    throw new Error('Invalid library retention database URL')
  if (
    !Number.isInteger(intervalMs) ||
    Number(intervalMs) < 60_000 ||
    Number(intervalMs) > 86_400_000
  )
    throw new Error('Invalid library retention interval')
  if (
    !Number.isInteger(batchSize) ||
    Number(batchSize) < 1 ||
    Number(batchSize) > 1000
  )
    throw new Error('Invalid library retention batch size')
  return {
    databaseUrl,
    intervalMs: Number(intervalMs),
    batchSize: Number(batchSize),
  }
}
