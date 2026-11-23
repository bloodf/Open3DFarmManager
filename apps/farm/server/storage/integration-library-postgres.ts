import { Readable } from 'node:stream'
import type { Sql } from 'postgres'
import type {
  IntegrationLibraryStore,
  LibraryAudit,
  LibraryItemView,
  LibraryVersionView,
  NewLibraryVersion,
  ResolvedLibraryVersion,
} from '../services/integration-library.ts'
import type { StorageMode } from '../utils/library/quota.ts'

const versionColumns = (sql: Sql) =>
  sql`v.id::text AS "id", v.item_id::text AS "itemId", v.version_number AS "versionNumber", v.sha256, v.size_bytes::float8 AS "sizeBytes", v.storage_location AS "storageLocation", v.original_name AS "originalName", v.kind, v.metadata->>'resinProfile' AS "resinProfile", v.plate_count AS "plateCount", v.created_at::float8 AS "createdAt"`

interface VersionRow extends LibraryVersionView {
  farmId: string
  title: string
}

function asMode(value: string): StorageMode {
  return value === 'server' ? 'server' : 'connector'
}

/**
 * Library rows for the integration role. Bytes for server mode are written by
 * the farm library blob store before `addVersion`; this store keeps metadata.
 */
export class PostgresIntegrationLibrary implements IntegrationLibraryStore {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }

  async getMode(farmId: string): Promise<StorageMode> {
    const rows = await this.sql<{ storageMode: string }[]>`
      SELECT storage_mode AS "storageMode" FROM farm.library_settings WHERE farm_id = ${farmId}::uuid`
    return asMode(rows[0]?.storageMode ?? 'connector')
  }

  async setMode(farmId: string, mode: StorageMode, now: number) {
    await this.sql`
      INSERT INTO farm.library_settings (farm_id, storage_mode, quota_bytes, retention_days, updated_by, updated_at)
      VALUES (${farmId}::uuid, ${mode}, 21474836480, 30, 'integration', ${now})
      ON CONFLICT (farm_id) DO UPDATE SET storage_mode = EXCLUDED.storage_mode, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`
  }

  async agentFor(farmId: string) {
    const rows = await this.sql<{ agentId: string }[]>`
      SELECT agent_id::text AS "agentId" FROM farm.printer_assignments
      WHERE farm_id = ${farmId}::uuid AND revoked_at IS NULL
      ORDER BY id LIMIT 1`
    return rows[0]?.agentId ?? null
  }

  private async modeOf(farmId: string) {
    return this.getMode(farmId)
  }

  private item(row: VersionRow, mode: StorageMode): LibraryItemView {
    return {
      id: row.itemId,
      farmId: row.farmId,
      title: row.title,
      storageMode: mode,
      latest: {
        id: row.id,
        itemId: row.itemId,
        versionNumber: row.versionNumber,
        sha256: row.sha256,
        sizeBytes: row.sizeBytes,
        storageLocation: asMode(row.storageLocation),
        originalName: row.originalName,
        kind: row.kind,
        ...(row.resinProfile == null ? {} : { resinProfile: row.resinProfile }),
        plateCount: row.plateCount,
        createdAt: row.createdAt,
      },
    }
  }

  async list(
    farmId: string,
    after: { createdAt: number; id: string } | null,
    limit: number,
  ) {
    const mode = await this.modeOf(farmId)
    const rows = await this.sql<VersionRow[]>`
      SELECT i.farm_id::text AS "farmId", i.title, ${versionColumns(this.sql)}
      FROM farm.library_items i
      JOIN farm.library_versions v ON v.id = (
        SELECT id FROM farm.library_versions
        WHERE item_id = i.id AND deleted_at IS NULL
        ORDER BY version_number DESC LIMIT 1
      )
      WHERE i.farm_id = ${farmId}::uuid AND i.archived = false
        AND (${after?.createdAt ?? null}::float8 IS NULL OR v.created_at < ${after?.createdAt ?? null}
          OR (v.created_at = ${after?.createdAt ?? null} AND i.id::text < ${after?.id ?? null}))
      ORDER BY v.created_at DESC, i.id DESC
      LIMIT ${limit}`
    return rows.map((row) => this.item(row, mode))
  }

  async getItem(itemId: string) {
    const rows = await this.sql<VersionRow[]>`
      SELECT i.farm_id::text AS "farmId", i.title, ${versionColumns(this.sql)}
      FROM farm.library_items i
      JOIN farm.library_versions v ON v.id = (
        SELECT id FROM farm.library_versions
        WHERE item_id = i.id AND deleted_at IS NULL
        ORDER BY version_number DESC LIMIT 1
      )
      WHERE i.id = ${itemId}::uuid AND i.archived = false`
    const row = rows[0]
    if (!row) return null
    return this.item(row, await this.modeOf(row.farmId))
  }

  async version(versionId: string): Promise<ResolvedLibraryVersion | null> {
    const rows = await this.sql<
      {
        id: string
        farmId: string
        sha256: string
        sizeBytes: number
        originalName: string
        storageLocation: string
        plateCount: number
        resinProfile: string | null
      }[]
    >`
      SELECT v.id::text AS "id", v.farm_id::text AS "farmId", v.sha256, v.size_bytes::float8 AS "sizeBytes",
        v.original_name AS "originalName", v.storage_location AS "storageLocation", v.plate_count AS "plateCount",
        v.metadata->>'resinProfile' AS "resinProfile"
      FROM farm.library_versions v
      JOIN farm.library_blobs b ON b.farm_id = v.farm_id AND b.sha256 = v.sha256
        AND b.storage_location = v.storage_location AND b.location_agent_id = v.location_agent_id
      WHERE v.id = ${versionId}::uuid AND v.deleted_at IS NULL AND b.purged_at IS NULL`
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      farmId: row.farmId,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      displayName: row.originalName,
      ...(row.resinProfile === null ? {} : { resinProfile: row.resinProfile }),
      storageMode: asMode(row.storageLocation),
      plateCount: row.plateCount,
    }
  }

  async retain(
    sha256: string,
    bytes: Uint8Array,
    mode: StorageMode,
    target?: { farmId: string; agentId: string | null },
  ) {
    if (!target) return
    const { libraryRuntime } = await import('../utils/library/runtime.ts')
    const { blobs, relay } = await libraryRuntime()
    const body = Readable.from([bytes])
    const options = { maxBytes: bytes.length }
    const stored =
      mode === 'server'
        ? await blobs?.put(body, options)
        : target.agentId &&
          (await relay?.put({
            ...options,
            body,
            farmId: target.farmId,
            agentId: target.agentId,
          }))
    if (!stored || stored.sha256 !== sha256 || stored.size !== bytes.length)
      throw new Error('Resin artifact storage unavailable')
  }

  async addVersion(version: NewLibraryVersion) {
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO farm.library_items (id, farm_id, title, tags, created_by, created_at)
        VALUES (${version.itemId}::uuid, ${version.farmId}::uuid, ${version.title}, '{}', 'integration', ${version.createdAt})`
      await tx`
        INSERT INTO farm.library_blobs (farm_id, sha256, size_bytes, storage_location, agent_id, created_at)
        VALUES (${version.farmId}::uuid, ${version.sha256}, ${version.sizeBytes}, ${version.storageLocation}, ${version.agentId}, ${version.createdAt})
        ON CONFLICT DO NOTHING`
      await tx`
        INSERT INTO farm.library_versions (id, farm_id, item_id, version_number, sha256, size_bytes, storage_location, agent_id, original_name, kind, plate_count, metadata, notes, uploaded_by, created_at)
        VALUES (${version.id}::uuid, ${version.farmId}::uuid, ${version.itemId}::uuid, ${version.versionNumber}, ${version.sha256}, ${version.sizeBytes}, ${version.storageLocation}, ${version.agentId}, ${version.originalName}, ${version.kind}, ${version.plateCount}, ${tx.json(version.resinProfile === undefined ? {} : { resinProfile: version.resinProfile })}, '', 'integration', ${version.createdAt})`
    })
    const item = await this.getItem(version.itemId)
    if (!item) throw new Error('library version was not stored')
    return item
  }

  async insertAudit(entry: LibraryAudit, now: number) {
    await this.sql`
      INSERT INTO farm.integration_audit (farm_id, app_id, printer_assignment_id, actor_kind, actor_id, action, resource_type, resource_id, outcome, occurred_at, details)
      VALUES (${entry.farmId}::uuid, ${entry.appId}::uuid, NULL, 'app', ${entry.appId}, ${entry.action}, ${entry.resourceType}, ${entry.resourceId}, ${entry.outcome}, ${now}, ${this.sql.json(entry.details)})`
  }
}
