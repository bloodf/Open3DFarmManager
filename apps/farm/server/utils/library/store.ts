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
import { DEFAULT_RETENTION_DAYS } from './retention.ts'

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
  kind: 'gcode' | '3mf'
  plateCount: number
  metadata: PrintFileMetadata
  notes: string
  uploadedBy: string
  createdAt: number
  deletedAt: number | null
  /** Set once retention removed the stored file; replays show "arquivo removido". */
  purgedAt: number | null
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

const ITEM_COLUMNS = (tx: Sql) =>
  tx`id, title, tags, archived, created_at::float8 AS "createdAt"`
const VERSION_COLUMNS = (tx: Sql) =>
  tx`v.id, v.item_id AS "itemId", v.version_number AS "versionNumber", v.sha256, v.size_bytes::float8 AS "sizeBytes",
     v.storage_location AS "storageLocation", b.agent_id AS "agentId", v.original_name AS "originalName", v.kind,
     v.plate_count AS "plateCount", v.metadata, v.notes, v.uploaded_by AS "uploadedBy",
     v.created_at::float8 AS "createdAt", v.deleted_at::float8 AS "deletedAt", b.purged_at::float8 AS "purgedAt"`

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

  getSettings(input: Authority) {
    return this.scoped<{
      ok: true
      settings: LibrarySettings
      canManage: boolean
    }>(input, async (tx, member) => ({
      ok: true as const,
      settings: await this.settingsOf(tx, input.farmId),
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
    return this.scoped<{ ok: true; settings: LibrarySettings }>(
      input,
      async (tx, member, accountId, now) => {
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
        return { ok: true as const, settings: next }
      },
    )
  }

  addVersion(input: Authority & { version: AddVersionInput }) {
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

        // One blob per (farm, sha256): a repeat adds a version reference only.
        const existing = (
          await tx<
            {
              storageLocation: StorageMode
              sizeBytes: number
              purgedAt: number | null
            }[]
          >`SELECT storage_location AS "storageLocation", size_bytes::float8 AS "sizeBytes", purged_at::float8 AS "purgedAt" FROM farm.library_blobs WHERE farm_id=${farm}::uuid AND sha256=${v.sha256}`
        )[0]
        if (existing && existing.sizeBytes !== v.sizeBytes)
          return { ok: false as const, reason: 'invalid-input' as const }
        // Retention removed the file but kept the row: the same bytes uploaded again restore it in place.
        const restoring = existing?.purgedAt != null
        // ponytail: a purged file can only come back where its row says; after a mode switch the user re-uploads under the old mode.
        if (restoring && existing!.storageLocation !== v.location)
          return { ok: false as const, reason: 'mode-mismatch' as const }
        if (!existing || restoring) {
          const basis = await quotaBasis(
            tx,
            farm,
            v.location,
            v.agentId,
            settings.quotaBytes,
          )
          const decision = basis
            ? checkQuota(v.location, basis, v.sizeBytes)
            : { ok: true as const }
          if (!decision.ok)
            return {
              ok: false as const,
              reason: 'quota-exceeded' as const,
              message: decision.message,
            }
          if (restoring)
            await tx`UPDATE farm.library_blobs SET purged_at=NULL WHERE farm_id=${farm}::uuid AND sha256=${v.sha256}`
          else
            await tx`INSERT INTO farm.library_blobs (farm_id, sha256, size_bytes, storage_location, agent_id, created_at)
          VALUES (${farm}::uuid, ${v.sha256}, ${v.sizeBytes}, ${v.location}, ${v.agentId ?? null}, ${now})`
        }
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
        const location = existing?.storageLocation ?? v.location
        const next = (
          await tx<
            { n: number }[]
          >`SELECT COALESCE(max(version_number), 0)::int + 1 AS n FROM farm.library_versions WHERE item_id=${item.id}::uuid`
        )[0]?.n
        if (!next)
          return { ok: false as const, reason: 'storage-unavailable' as const }
        const id = randomUUID()
        await tx`INSERT INTO farm.library_versions (id, farm_id, item_id, version_number, sha256, size_bytes, storage_location, original_name, kind, plate_count, metadata, notes, uploaded_by, created_at)
        VALUES (${id}::uuid, ${farm}::uuid, ${item.id}::uuid, ${next}, ${v.sha256}, ${v.sizeBytes}, ${location}, ${v.originalName}, ${v.kind}, ${v.plateCount}, ${tx.json(metadata.data as never)}, ${v.notes ?? ''}, ${accountId}, ${now})`
        const stored = (
          await tx<
            LibraryVersion[]
          >`SELECT ${VERSION_COLUMNS(tx)} FROM farm.library_versions v JOIN farm.library_blobs b ON b.farm_id=v.farm_id AND b.sha256=v.sha256 WHERE v.id=${id}::uuid`
        )[0]
        if (!stored)
          return { ok: false as const, reason: 'storage-unavailable' as const }
        return {
          ok: true as const,
          item,
          version: stored,
          deduplicated: existing !== undefined && !restoring,
          orphanedServerCopy:
            !restoring &&
            existing?.storageLocation === 'connector' &&
            v.location === 'server',
        }
      },
    )
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
        JOIN farm.library_blobs b ON b.farm_id=v.farm_id AND b.sha256=v.sha256
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
        if (!writers.includes(member.role))
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
