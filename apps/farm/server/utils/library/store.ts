import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { PrintFileMetadata } from '../../../../../packages/shared/src/print-file/metadata.ts'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionPolicy,
  type SessionRecord,
} from '../auth/session-contract.ts'
import {
  checkQuota,
  connectorReports,
  defaultQuotaBytes,
  quotaBasis,
  serverUsedBytes,
  summarizeUsage,
  type StorageMode,
  type StorageUsage,
} from './quota.ts'
import { DEFAULT_RETENTION_DAYS, lockLibraryBlob } from './retention.ts'

export { DEFAULT_QUOTA_BYTES } from './quota.ts'
export { DEFAULT_RETENTION_DAYS }
export type { StorageMode }
export type LibraryFailure = {
  ok: false
  reason:
    | 'invalid-input'
    | 'unauthorized'
    | 'forbidden'
    | 'denied'
    | 'not-found'
    | 'mode-mismatch'
    | 'quota-exceeded'
    | 'storage-unavailable'
  /** Accessible pt-BR text for the user, when the refusal needs one (quota). */
  message?: string
}
type Authority = {
  sessionRecordId: string
  policy: SessionPolicy
  farmId: string
}

export interface LibrarySettings {
  storageMode: StorageMode
  quotaBytes: number
  retentionDays: number
  /** Newest live versions kept per item; null keeps all. */
  keepVersions: number | null
}
export interface LibraryVersion {
  id: string
  itemId: string
  versionNumber: number
  sha256: string
  sizeBytes: number
  /** Where this version's file actually is; never rewritten by a mode switch. */
  storageLocation: StorageMode
  agentId: string | null
  originalName: string
  kind: 'gcode' | '3mf' | 'resin'
  plateCount: number
  metadata: PrintFileMetadata & { resinProfile?: string }
  hasThumbnail: boolean
  notes: string
  uploadedBy: string
  createdAt: number
  deletedAt: number | null
  /** Set once retention removed the stored file; replays show "arquivo removido". */
  purgedAt: number | null
}
export interface LibraryLocation {
  location: StorageMode
  /** Connector that holds the copies (Connector location only). */
  agentId: string | null
  files: number
  bytes: number
}
export interface LibrarySearch {
  /** Substring of the title, case-insensitive. */
  title?: string
  tag?: string
  /** Substring of the printer model, case-insensitive. */
  printerModel?: string
  nozzle?: number
  /** Filament type of any tool, case-insensitive. */
  material?: string
  /** Substring of the slicer name, case-insensitive. */
  slicer?: string
}
export interface LibraryCursor {
  createdAt: number
  id: string
}
export interface LibraryListing extends LibraryItem {
  /** Newest version that is not deleted. */
  latest: LibraryVersion
}
export interface LibraryItem {
  id: string
  title: string
  tags: string[]
  archived: boolean
  createdAt: number
}
export interface AddVersionInput {
  /** Existing item to add a version to; otherwise a new item is created from `title`. */
  itemId?: string
  title?: string
  tags?: string[]
  sha256: string
  sizeBytes: number
  /** Where the caller put the bytes. Must match the farm's current mode. */
  location: StorageMode
  /** Connector that holds the file (connector mode only). */
  agentId?: string
  originalName: string
  kind: 'gcode' | '3mf'
  plateCount: number
  metadata: unknown
  notes?: string
}
export interface AddVersionResult {
  ok: true
  item: LibraryItem
  version: LibraryVersion
  /** Same bytes were already stored: this version only references them. */
  deduplicated: boolean
  /** Server file the caller wrote that no version uses (bytes already live on a Connector). Safe to discard. */
  orphanedServerCopy: boolean
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const writers = ['owner', 'admin', 'operator']
const managers = ['owner', 'admin']
const MAX_PAGE = 100

const ITEM_COLUMNS = (tx: Sql) =>
  tx`id, title, tags, archived, created_at::float8 AS "createdAt"`
/** `lite` drops the thumbnail payload (up to 256 KiB per version) from lists. */
const VERSION_COLUMNS = (tx: Sql, lite = false) =>
  tx`${lite ? tx`v.metadata - 'thumbnail' AS metadata` : tx`v.metadata`}, jsonb_exists(v.metadata, 'thumbnail') AS "hasThumbnail", v.id, v.item_id AS "itemId", v.version_number AS "versionNumber", v.sha256, v.size_bytes::float8 AS "sizeBytes",
     v.storage_location AS "storageLocation", COALESCE(v.agent_id, b.agent_id) AS "agentId", v.original_name AS "originalName",
     CASE WHEN v.metadata ? 'resinProfile' THEN 'resin' ELSE v.kind END AS kind,
     v.plate_count AS "plateCount", v.notes, v.uploaded_by AS "uploadedBy",
     v.created_at::float8 AS "createdAt", v.deleted_at::float8 AS "deletedAt", b.purged_at::float8 AS "purgedAt"`
const VERSION_BLOB_JOIN = (tx: Sql) =>
  tx`b.farm_id=v.farm_id AND b.sha256=v.sha256 AND b.storage_location=v.storage_location AND b.location_agent_id=v.location_agent_id`

/**
 * Library metadata. Server mode keeps the file in the blob store; Connector mode
 * keeps it on the Connector and the server holds metadata, thumbnail and hash
 * only. Versions and dedupe behave the same in both.
 */
export class PostgresLibrary {
  private inflight = 0
  private readonly sql: Sql
  private readonly clock: () => number

  constructor(sql: Sql, clock: () => number = Date.now) {
    this.sql = sql
    this.clock = clock
  }

  private async scoped<T>(
    input: Authority,
    action: (
      tx: Sql,
      member: { role: string },
      accountId: string,
      now: number,
    ) => Promise<T | LibraryFailure>,
  ): Promise<T | LibraryFailure> {
    if (
      !uuid.test(input.farmId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionRecordId) ||
      !Number.isSafeInteger(input.policy.idleTimeoutMs) ||
      input.policy.idleTimeoutMs <= 0
    )
      return { ok: false, reason: 'invalid-input' }
    if (this.inflight >= 32) return { ok: false, reason: 'storage-unavailable' }
    this.inflight++
    try {
      return await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '5000ms'`
        await tx`SET LOCAL lock_timeout = '2000ms'`
        const accounts = await tx<
          AccountSessionState[]
        >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${input.sessionRecordId}) FOR SHARE`
        const sessions = await tx<
          SessionRecord[]
        >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id = ${input.sessionRecordId} FOR UPDATE`
        const firstAt = this.clock()
        const first = evaluateSession(
          input.sessionRecordId,
          sessions[0] ?? null,
          accounts[0] ?? null,
          firstAt,
          input.policy,
        )
        if (!first.ok)
          return { ok: false as const, reason: 'unauthorized' as const }
        const members =
          await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${input.farmId}::uuid AND account_id = ${first.accountId} FOR SHARE`
        if (!members[0] || members[0].revoked_at !== null)
          return { ok: false as const, reason: 'forbidden' as const }
        const result = await action(
          tx as unknown as Sql,
          { role: String(members[0].role) },
          first.accountId,
          firstAt,
        )
        const now = this.clock()
        const current = evaluateSession(
          input.sessionRecordId,
          sessions[0] ?? null,
          accounts[0] ?? null,
          now,
          input.policy,
        )
        if (now < firstAt || !current.ok)
          return { ok: false as const, reason: 'unauthorized' as const }
        await tx`UPDATE farm.account_sessions SET last_seen_at=${current.touchAt} WHERE id=${input.sessionRecordId}`
        return result
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    } finally {
      this.inflight--
    }
  }

  private async settingsOf(tx: Sql, farmId: string): Promise<LibrarySettings> {
    const rows = await tx<
      LibrarySettings[]
    >`SELECT storage_mode AS "storageMode", quota_bytes::float8 AS "quotaBytes", retention_days AS "retentionDays", keep_versions AS "keepVersions" FROM farm.library_settings WHERE farm_id=${farmId}::uuid`
    // No row yet: farm defaults (Connector mode).
    return (
      rows[0] ?? {
        storageMode: 'connector',
        quotaBytes: defaultQuotaBytes(),
        retentionDays: DEFAULT_RETENTION_DAYS,
        keepVersions: null,
      }
    )
  }

  /** Where the farm's files actually are, per location and Connector. A mode switch never moves them. */
  private locationsOf(tx: Sql, farmId: string): Promise<LibraryLocation[]> {
    return tx<
      LibraryLocation[]
    >`SELECT storage_location AS location, agent_id AS "agentId", count(*)::int AS files, COALESCE(sum(size_bytes), 0)::float8 AS bytes
      FROM farm.library_blobs WHERE farm_id=${farmId}::uuid GROUP BY storage_location, agent_id ORDER BY storage_location, agent_id`
  }

  getSettings(input: Authority) {
    return this.scoped<{
      ok: true
      settings: LibrarySettings
      locations: LibraryLocation[]
      canManage: boolean
    }>(input, async (tx, member) => ({
      ok: true as const,
      settings: await this.settingsOf(tx, input.farmId),
      locations: await this.locationsOf(tx, input.farmId),
      canManage: managers.includes(member.role),
    }))
  }

  /** Owner/admin only. Affects future uploads; existing versions keep their recorded location. */
  setSettings(input: Authority & Partial<LibrarySettings>) {
    const { storageMode, quotaBytes, retentionDays, keepVersions } = input
    if (
      (storageMode !== undefined &&
        storageMode !== 'server' &&
        storageMode !== 'connector') ||
      (quotaBytes !== undefined &&
        !(Number.isSafeInteger(quotaBytes) && quotaBytes >= 0)) ||
      (retentionDays !== undefined &&
        !(
          Number.isInteger(retentionDays) &&
          retentionDays >= 1 &&
          retentionDays <= 3650
        )) ||
      (keepVersions !== undefined &&
        keepVersions !== null &&
        !(
          Number.isInteger(keepVersions) &&
          keepVersions >= 1 &&
          keepVersions <= 1000
        ))
    )
      return Promise.resolve({ ok: false, reason: 'invalid-input' } as const)
    return this.scoped<{
      ok: true
      settings: LibrarySettings
      locations: LibraryLocation[]
    }>(input, async (tx, member, accountId, now) => {
      if (!managers.includes(member.role))
        return { ok: false as const, reason: 'denied' as const }
      const next = { ...(await this.settingsOf(tx, input.farmId)) }
      if (storageMode !== undefined) next.storageMode = storageMode
      if (quotaBytes !== undefined) next.quotaBytes = quotaBytes
      if (retentionDays !== undefined) next.retentionDays = retentionDays
      if (keepVersions !== undefined) next.keepVersions = keepVersions
      await tx`INSERT INTO farm.library_settings (farm_id, storage_mode, quota_bytes, retention_days, keep_versions, updated_by, updated_at)
        VALUES (${input.farmId}::uuid, ${next.storageMode}, ${next.quotaBytes}, ${next.retentionDays}, ${next.keepVersions}, ${accountId}, ${now})
        ON CONFLICT (farm_id) DO UPDATE SET storage_mode=EXCLUDED.storage_mode, quota_bytes=EXCLUDED.quota_bytes,
          retention_days=EXCLUDED.retention_days, keep_versions=EXCLUDED.keep_versions, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`
      return {
        ok: true as const,
        settings: next,
        locations: await this.locationsOf(tx, input.farmId),
      }
    })
  }

  /**
   * Refuses an upload before any byte moves: writers only and, in Connector
   * mode, an approved Connector of this farm.
   */
  uploadContext(input: Authority & { agentId?: string }) {
    if (input.agentId !== undefined && !uuid.test(input.agentId))
      return Promise.resolve({ ok: false, reason: 'invalid-input' } as const)
    return this.scoped<{ ok: true; settings: LibrarySettings }>(
      input,
      async (tx, member) => {
        if (!writers.includes(member.role))
          return { ok: false as const, reason: 'denied' as const }
        const settings = await this.settingsOf(tx, input.farmId)
        if (settings.storageMode === 'connector') {
          if (!input.agentId)
            return { ok: false as const, reason: 'invalid-input' as const }
          const enrolled =
            await tx`SELECT 1 FROM farm.connector_enrollments WHERE farm_id=${input.farmId}::uuid AND agent_id=${input.agentId}::uuid AND status='approved' FOR SHARE`
          if (!enrolled[0])
            return { ok: false as const, reason: 'forbidden' as const }
        }
        return { ok: true as const, settings }
      },
    )
  }

  addVersion(
    input: Authority & {
      version: AddVersionInput
      /** Throws when the bytes this upload wrote are no longer there. */
      confirmFile?: () => Promise<void>
    },
  ) {
    const v = input.version
    const metadata = PrintFileMetadata.safeParse(v.metadata)
    const title = v.title?.trim()
    if (
      !metadata.success ||
      !sha256Pattern.test(v.sha256) ||
      !Number.isSafeInteger(v.sizeBytes) ||
      v.sizeBytes < 0 ||
      (v.location !== 'server' && v.location !== 'connector') ||
      (v.location === 'connector'
        ? !(v.agentId && uuid.test(v.agentId))
        : v.agentId !== undefined) ||
      !(v.kind === 'gcode' || v.kind === '3mf') ||
      !Number.isInteger(v.plateCount) ||
      v.originalName.length < 1 ||
      v.originalName.length > 255 ||
      (v.notes ?? '').length > 2000 ||
      (v.itemId === undefined
        ? !title || title.length > 200
        : !uuid.test(v.itemId) || title !== undefined)
    )
      return Promise.resolve({ ok: false, reason: 'invalid-input' } as const)
    const tags = [
      ...new Set((v.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
    ]
    if (tags.length > 32 || tags.some((tag) => tag.length > 64))
      return Promise.resolve({ ok: false, reason: 'invalid-input' } as const)
    return this.scoped<AddVersionResult>(
      input,
      async (tx, member, accountId, now) => {
        if (!writers.includes(member.role))
          return { ok: false as const, reason: 'denied' as const }
        const farm = input.farmId
        const settings = await this.settingsOf(tx, farm)
        if (settings.storageMode !== v.location)
          return { ok: false as const, reason: 'mode-mismatch' as const }
        if (v.location === 'connector') {
          const enrolled =
            await tx`SELECT 1 FROM farm.connector_enrollments WHERE farm_id=${farm}::uuid AND agent_id=${v.agentId!}::uuid AND status='approved' FOR SHARE`
          if (!enrolled[0])
            return { ok: false as const, reason: 'forbidden' as const }
        }
        // Serialise concurrent uploads of one farm so item numbers and the quota stay exact.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'library:' + farm}, 0))`
        await lockLibraryBlob(tx as unknown as Sql, v.sha256)

        let item: LibraryItem | undefined
        if (v.itemId !== undefined) {
          item = (
            await tx<
              LibraryItem[]
            >`SELECT id, title, tags, archived, created_at::float8 AS "createdAt" FROM farm.library_items
            WHERE farm_id=${farm}::uuid AND id=${v.itemId}::uuid FOR UPDATE`
          )[0]
          if (!item) return { ok: false as const, reason: 'not-found' as const }
        }

        // Blobs are deduplicated per (farm, sha256, storage_location, agent_id).
        const existingBlobs = await tx<
          {
            storageLocation: StorageMode
            agentId: string | null
            sizeBytes: number
            purgedAt: number | null
          }[]
        >`SELECT storage_location AS "storageLocation", agent_id AS "agentId", size_bytes::float8 AS "sizeBytes", purged_at::float8 AS "purgedAt"
          FROM farm.library_blobs
          WHERE farm_id=${farm}::uuid AND sha256=${v.sha256}
          ORDER BY created_at ASC, storage_location ASC, agent_id ASC`
        if (existingBlobs.some((b) => b.sizeBytes !== v.sizeBytes))
          return { ok: false as const, reason: 'invalid-input' as const }

        const atTarget = existingBlobs.find(
          (b) =>
            b.storageLocation === v.location &&
            b.agentId === (v.agentId ?? null),
        )
        // Server uploads reuse an existing live Connector copy so no duplicate server copy is kept.
        const reusableConnector =
          v.location === 'server' && !atTarget
            ? existingBlobs.find(
                (b) => b.storageLocation === 'connector' && b.purgedAt == null,
              )
            : undefined
        const matched = atTarget ?? reusableConnector
        // Retention removed the file at this location, but kept the row: the same bytes uploaded again restore it in place.
        const restoring = matched?.purgedAt != null
        const targetLocation = matched?.storageLocation ?? v.location
        const targetAgentId = matched ? matched.agentId : (v.agentId ?? null)

        if (!matched || restoring) {
          const basis = await quotaBasis(
            tx,
            farm,
            targetLocation,
            targetAgentId ?? undefined,
            settings.quotaBytes,
          )
          const decision = basis
            ? checkQuota(targetLocation, basis, v.sizeBytes)
            : { ok: true as const }
          if (!decision.ok)
            return {
              ok: false as const,
              reason: 'quota-exceeded' as const,
              message: decision.message,
            }
          if (restoring)
            await tx`UPDATE farm.library_blobs SET purged_at=NULL
              WHERE farm_id=${farm}::uuid AND sha256=${v.sha256} AND storage_location=${targetLocation}
                AND ${targetLocation === 'connector' ? tx`agent_id=${targetAgentId!}::uuid` : tx`agent_id IS NULL`}`
          else
            await tx`INSERT INTO farm.library_blobs (farm_id, sha256, size_bytes, storage_location, agent_id, created_at)
              VALUES (${farm}::uuid, ${v.sha256}, ${v.sizeBytes}, ${targetLocation}, ${targetAgentId}, ${now})`
        }
        // Retention may have removed the file after it was written and before
        // these locks. Throwing rolls the record back, so the upload is retried.
        // A server file is shared across farms, so it is always checked.
        if (
          targetLocation === v.location &&
          targetAgentId === (v.agentId ?? null) &&
          (targetLocation === 'server' || restoring)
        )
          await input.confirmFile?.()
        // Refusals above return before this point, so a rejected upload creates no item.
        item ??= (
          await tx<
            LibraryItem[]
          >`INSERT INTO farm.library_items (id, farm_id, title, tags, created_by, created_at)
          VALUES (${randomUUID()}::uuid, ${farm}::uuid, ${title!}, ${tags}, ${accountId}, ${now})
          RETURNING id, title, tags, archived, created_at::float8 AS "createdAt"`
        )[0]
        if (!item)
          return { ok: false as const, reason: 'storage-unavailable' as const }
        const next = (
          await tx<
            { n: number }[]
          >`SELECT COALESCE(max(version_number), 0)::int + 1 AS n FROM farm.library_versions WHERE item_id=${item.id}::uuid`
        )[0]?.n
        if (!next)
          return { ok: false as const, reason: 'storage-unavailable' as const }
        const id = randomUUID()
        await tx`INSERT INTO farm.library_versions (id, farm_id, item_id, version_number, sha256, size_bytes, storage_location, agent_id, original_name, kind, plate_count, metadata, notes, uploaded_by, created_at)
        VALUES (${id}::uuid, ${farm}::uuid, ${item.id}::uuid, ${next}, ${v.sha256}, ${v.sizeBytes}, ${targetLocation}, ${targetAgentId}, ${v.originalName}, ${v.kind}, ${v.plateCount}, ${tx.json(metadata.data as never)}, ${v.notes ?? ''}, ${accountId}, ${now})`
        const stored = (
          await tx<
            LibraryVersion[]
          >`SELECT ${VERSION_COLUMNS(tx)} FROM farm.library_versions v JOIN farm.library_blobs b ON ${VERSION_BLOB_JOIN(tx)} WHERE v.id=${id}::uuid`
        )[0]
        if (!stored)
          return { ok: false as const, reason: 'storage-unavailable' as const }
        return {
          ok: true as const,
          item,
          version: stored,
          deduplicated: matched !== undefined && !restoring,
          orphanedServerCopy:
            !restoring &&
            v.location === 'server' &&
            targetLocation === 'connector',
        }
      },
    )
  }

  /**
   * Items whose newest live version matches every given filter, newest first.
   * Keyset paging on (created_at, id): an insert never shifts a later page.
   */
  searchItems(
    input: Authority & {
      search?: LibrarySearch
      after?: LibraryCursor
      limit?: number
    },
  ) {
    const f = input.search ?? {}
    const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_PAGE)
    if (
      (input.after !== undefined &&
        !(
          uuid.test(input.after.id) &&
          Number.isSafeInteger(input.after.createdAt)
        )) ||
      (f.nozzle !== undefined && !(Number.isFinite(f.nozzle) && f.nozzle > 0))
    )
      return Promise.resolve({ ok: false, reason: 'invalid-input' } as const)
    return this.scoped<{
      ok: true
      items: LibraryListing[]
      next: LibraryCursor | null
    }>(input, async (tx) => {
      const farm = input.farmId
      const contains = (column: ReturnType<Sql>, value: string) =>
        tx`position(lower(${value}) in lower(coalesce(${column}, ''))) > 0`
      const rows = await tx<
        (LibraryItem & { latest: LibraryVersion })[]
      >`SELECT i.id, i.title, i.tags, i.archived, i.created_at::float8 AS "createdAt", to_jsonb(lv) AS latest
        FROM farm.library_items i
        JOIN LATERAL (SELECT ${VERSION_COLUMNS(tx, true)} FROM farm.library_versions v
          JOIN farm.library_blobs b ON ${VERSION_BLOB_JOIN(tx)}
          WHERE v.farm_id=i.farm_id AND v.item_id=i.id AND v.deleted_at IS NULL
          ORDER BY v.version_number DESC LIMIT 1) lv ON true
        WHERE i.farm_id=${farm}::uuid
        ${f.title ? tx`AND ${contains(tx`i.title`, f.title)}` : tx``}
        ${f.tag ? tx`AND EXISTS (SELECT 1 FROM unnest(i.tags) g WHERE lower(g)=lower(${f.tag}))` : tx``}
        ${f.printerModel ? tx`AND ${contains(tx`lv.metadata->>'printerModel'`, f.printerModel)}` : tx``}
        ${f.slicer ? tx`AND ${contains(tx`lv.metadata->>'slicer'`, f.slicer)}` : tx``}
        ${f.material ? tx`AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(lv.metadata->'tools', '[]'::jsonb)) t WHERE lower(t->>'filamentType')=lower(${f.material}))` : tx``}
        ${f.nozzle !== undefined ? tx`AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(lv.metadata->'tools', '[]'::jsonb)) t WHERE (t->>'nozzleDiameter')::numeric=${String(f.nozzle)}::numeric)` : tx``}
        ${input.after ? tx`AND (i.created_at < ${input.after.createdAt} OR (i.created_at = ${input.after.createdAt} AND i.id > ${input.after.id}::uuid))` : tx``}
        ORDER BY i.created_at DESC, i.id LIMIT ${limit + 1}`
      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      return {
        ok: true as const,
        items: page,
        next:
          rows.length > limit && last
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      }
    })
  }

  listItems(input: Authority) {
    return this.scoped<{ ok: true; items: LibraryItem[] }>(
      input,
      async (tx) => ({
        ok: true as const,
        items: await tx<
          LibraryItem[]
        >`SELECT ${ITEM_COLUMNS(tx)} FROM farm.library_items WHERE farm_id=${input.farmId}::uuid ORDER BY created_at DESC, id LIMIT 200`,
      }),
    )
  }

  /** One live version with its full metadata, thumbnail included. */
  getVersion(input: Authority & { versionId: string }) {
    if (!uuid.test(input.versionId))
      return Promise.resolve({ ok: false, reason: 'invalid-input' } as const)
    return this.scoped<{
      ok: true
      version: LibraryVersion
      item: LibraryItem
    }>(input, async (tx) => {
      const version = (
        await tx<
          LibraryVersion[]
        >`SELECT ${VERSION_COLUMNS(tx)} FROM farm.library_versions v
          JOIN farm.library_blobs b ON ${VERSION_BLOB_JOIN(tx)}
          WHERE v.farm_id=${input.farmId}::uuid AND v.id=${input.versionId}::uuid AND v.deleted_at IS NULL`
      )[0]
      if (!version) return { ok: false as const, reason: 'not-found' as const }
      const item = (
        await tx<
          LibraryItem[]
        >`SELECT ${ITEM_COLUMNS(tx)} FROM farm.library_items WHERE farm_id=${input.farmId}::uuid AND id=${version.itemId}::uuid`
      )[0]
      if (!item) return { ok: false as const, reason: 'not-found' as const }
      return { ok: true as const, version, item }
    })
  }

  /** Newest live version with this content hash, for replaying a finished job. */
  getVersionBySha256(input: Authority & { sha256: string }) {
    if (!/^[0-9a-f]{64}$/.test(input.sha256))
      return Promise.resolve({ ok: false, reason: 'invalid-input' } as const)
    return this.scoped<{
      ok: true
      version: LibraryVersion
      item: LibraryItem
    }>(input, async (tx) => {
      const version = (
        await tx<
          LibraryVersion[]
        >`SELECT ${VERSION_COLUMNS(tx)} FROM farm.library_versions v
          JOIN farm.library_blobs b ON ${VERSION_BLOB_JOIN(tx)}
          WHERE v.farm_id=${input.farmId}::uuid AND v.sha256=${input.sha256} AND v.deleted_at IS NULL
          ORDER BY v.created_at DESC, v.id LIMIT 1`
      )[0]
      if (!version) return { ok: false as const, reason: 'not-found' as const }
      const item = (
        await tx<
          LibraryItem[]
        >`SELECT ${ITEM_COLUMNS(tx)} FROM farm.library_items WHERE farm_id=${input.farmId}::uuid AND id=${version.itemId}::uuid`
      )[0]
      if (!item) return { ok: false as const, reason: 'not-found' as const }
      return { ok: true as const, version, item }
    })
  }

  /** Soft-deleted versions are hidden unless asked for; each row reports its real location. */
  listVersions(
    input: Authority & { itemId: string; includeDeleted?: boolean },
  ) {
    if (!uuid.test(input.itemId))
      return Promise.resolve({ ok: false, reason: 'invalid-input' } as const)
    return this.scoped<{ ok: true; versions: LibraryVersion[] }>(
      input,
      async (tx) => ({
        ok: true as const,
        versions: await tx<
          LibraryVersion[]
        >`SELECT ${VERSION_COLUMNS(tx)} FROM farm.library_versions v
        JOIN farm.library_blobs b ON ${VERSION_BLOB_JOIN(tx)}
        WHERE v.farm_id=${input.farmId}::uuid AND v.item_id=${input.itemId}::uuid AND (${input.includeDeleted === true} OR v.deleted_at IS NULL)
        ORDER BY v.version_number DESC LIMIT 500`,
      }),
    )
  }

  /** Used and available space for the farm's active mode (server disk, or what its Connectors report). */
  getUsage(input: Authority) {
    return this.scoped<{ ok: true; usage: StorageUsage }>(input, async (tx) => {
      const settings = await this.settingsOf(tx, input.farmId)
      return {
        ok: true as const,
        usage: summarizeUsage(
          settings.storageMode,
          {
            usedBytes: await serverUsedBytes(tx, input.farmId),
            quotaBytes: settings.quotaBytes,
          },
          await connectorReports(tx, input.farmId),
        ),
      }
    })
  }

  /**
   * Soft delete; the blob stays for the retention window, then the retention
   * job (retention.ts, its own database role) purges it.
   */
  softDeleteVersion(input: Authority & { versionId: string }) {
    if (!uuid.test(input.versionId))
      return Promise.resolve({ ok: false, reason: 'invalid-input' } as const)
    return this.scoped<{ ok: true; deletedAt: number }>(
      input,
      async (tx, member, _accountId, now) => {
        if (!managers.includes(member.role))
          return { ok: false as const, reason: 'denied' as const }
        const rows = await tx<
          { deletedAt: number }[]
        >`UPDATE farm.library_versions SET deleted_at=${now} WHERE id=${input.versionId}::uuid AND farm_id=${input.farmId}::uuid AND deleted_at IS NULL RETURNING deleted_at::float8 AS "deletedAt"`
        if (!rows[0])
          return { ok: false as const, reason: 'not-found' as const }
        return { ok: true as const, deletedAt: rows[0].deletedAt }
      },
    )
  }
}
