import { Readable } from 'node:stream'
import type { Sql } from 'postgres'
import {
  LibraryQuotaExceeded,
  type IntegrationLibraryStore,
  type LibraryAudit,
  type LibraryItemView,
  type LibraryVersionView,
  type NewLibraryVersion,
  type LibraryFile,
  type ResolvedLibraryVersion,
} from '../services/integration-library.ts'
import {
  checkQuota,
  defaultQuotaBytes,
  quotaBasis,
  type StorageMode,
} from '../utils/library/quota.ts'
import { lockLibraryBlob } from '../utils/library/retention.ts'
import { LIBRARY_RELAY_MAX_READ } from '../../../../packages/farm-protocol/src/library-relay.ts'

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
 * The same quota the farm library applies. Bytes already kept at that location
 * never count again; a purged record does, because its file comes back.
 */
async function fitsQuota(sql: Sql, file: LibraryFile) {
  const kept = await sql`
    SELECT 1 FROM farm.library_blobs
    WHERE farm_id = ${file.farmId}::uuid AND sha256 = ${file.sha256} AND storage_location = ${file.mode}
      AND agent_id IS NOT DISTINCT FROM ${file.agentId}::uuid AND purged_at IS NULL`
  if (kept.length > 0) return true
  const settings = await sql<{ quotaBytes: number }[]>`
    SELECT quota_bytes::float8 AS "quotaBytes" FROM farm.library_settings WHERE farm_id = ${file.farmId}::uuid`
  const basis = await quotaBasis(
    sql,
    file.farmId,
    file.mode,
    file.agentId ?? undefined,
    settings[0]?.quotaBytes ?? defaultQuotaBytes(),
  )
  return !basis || checkQuota(file.mode, basis, file.sizeBytes).ok
}

/** Transaction lock: the one every upload of a farm takes before its quota check. */
function lockLibraryFarm(tx: Sql, farmId: string) {
  return tx`SELECT pg_advisory_xact_lock(hashtextextended(${'library:' + farmId}, 0))`
}

/** Files recorded on one Connector. */
function keptOn(tx: Sql, farmId: string, agentId: string) {
  return tx<{ sha256: string; sizeBytes: number }[]>`
    SELECT sha256, size_bytes::float8 AS "sizeBytes" FROM farm.library_blobs
    WHERE farm_id = ${farmId}::uuid AND storage_location = 'connector'
      AND agent_id = ${agentId}::uuid AND purged_at IS NULL`
}

/** Records a stored file, or revives the record retention marked purged. */
function keepBlob(sql: Sql, file: LibraryFile, createdAt: number) {
  return sql`
    INSERT INTO farm.library_blobs (farm_id, sha256, size_bytes, storage_location, agent_id, created_at)
    VALUES (${file.farmId}::uuid, ${file.sha256}, ${file.sizeBytes}, ${file.mode}, ${file.agentId}, ${createdAt})
    ON CONFLICT (farm_id, sha256, storage_location, location_agent_id) DO UPDATE SET purged_at = NULL`
}

/**
 * Library rows for the integration role. `retain` writes the bytes through the
 * farm library runtime (blob store or Connector relay) before `addVersion`.
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
      VALUES (${farmId}::uuid, ${mode}, ${defaultQuotaBytes()}, 30, 'integration', ${now})
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
        kind: row.resinProfile == null ? row.kind : 'resin',
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
        agentId: string | null
      }[]
    >`
      SELECT v.id::text AS "id", v.farm_id::text AS "farmId", v.sha256, v.size_bytes::float8 AS "sizeBytes",
        v.original_name AS "originalName", v.storage_location AS "storageLocation", v.plate_count AS "plateCount",
        v.metadata->>'resinProfile' AS "resinProfile", v.agent_id::text AS "agentId"
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
      ...(row.agentId === null ? {} : { agentId: row.agentId }),
      plateCount: row.plateCount,
    }
  }

  fits(file: LibraryFile) {
    return fitsQuota(this.sql, file)
  }

  /**
   * Copies a Connector-mode file to the Connector of the printer that will
   * print it, relayed from the Connector that holds the version. The server
   * keeps no bytes.
   */
  async placeOn(versionId: string, agentId: string) {
    const rows = await this.sql<
      {
        farmId: string
        sha256: string
        sizeBytes: number
        sourceAgentId: string | null
      }[]
    >`
      SELECT farm_id::text AS "farmId", sha256, size_bytes::float8 AS "sizeBytes", agent_id::text AS "sourceAgentId"
      FROM farm.library_versions WHERE id = ${versionId}::uuid AND deleted_at IS NULL`
    const row = rows[0]
    if (!row?.sourceAgentId || row.sourceAgentId === agentId) return 'ready'
    const { farmId, sha256, sizeBytes, sourceAgentId } = row
    const copy: LibraryFile = {
      farmId,
      sha256,
      sizeBytes,
      mode: 'connector',
      agentId,
    }
    // The Connector's last report and what was recorded on it at that moment.
    const before = await this.sql.begin(async (tx) => {
      await lockLibraryFarm(tx as unknown as Sql, farmId)
      return {
        basis: await quotaBasis(
          tx as unknown as Sql,
          farmId,
          'connector',
          agentId,
          0,
        ),
        kept: new Set(
          (await keptOn(tx as unknown as Sql, farmId, agentId)).map(
            (file) => file.sha256,
          ),
        ),
      }
    })
    if (before.kept.has(sha256)) return 'ready'
    const fits = (extraBytes: number) =>
      !before.basis ||
      checkQuota(
        'connector',
        {
          usedBytes: before.basis.usedBytes + extraBytes,
          quotaBytes: before.basis.quotaBytes,
        },
        sizeBytes,
      ).ok
    if (!fits(0)) return 'quota-exceeded'

    const { libraryRuntime } = await import('../utils/library/runtime.ts')
    const { relay } = await libraryRuntime()
    if (!relay) throw new Error('Library storage unavailable')
    async function* source() {
      for (let offset = 0; offset < sizeBytes;) {
        const part = await relay!.read({
          farmId,
          agentId: sourceAgentId,
          sha256,
          offset,
          length: Math.min(LIBRARY_RELAY_MAX_READ, sizeBytes - offset),
        })
        if (part.length === 0) throw new Error('Library file is truncated')
        offset += part.length
        yield part
      }
    }
    const stored = await relay.put({
      farmId,
      agentId,
      body: source(),
      maxBytes: sizeBytes,
    })
    if (stored.sha256 !== sha256 || stored.size !== sizeBytes)
      throw new Error('Library storage unavailable')
    // Checked again under the farm lock: files recorded while these bytes moved
    // are not in the report yet, so concurrent copies are added to it here. The
    // earlier report is used because a newer one may already count this file.
    return this.sql.begin(async (tx) => {
      await lockLibraryFarm(tx as unknown as Sql, farmId)
      await lockLibraryBlob(tx as unknown as Sql, sha256)
      const kept = await keptOn(tx as unknown as Sql, farmId, agentId)
      if (kept.some((file) => file.sha256 === sha256)) return 'ready' as const
      const added = kept
        .filter((file) => !before.kept.has(file.sha256))
        .reduce((sum, file) => sum + file.sizeBytes, 0)
      if (!fits(added)) {
        if (stored.created)
          await relay.discard({ farmId, agentId, sha256 }).catch(() => {})
        return 'quota-exceeded' as const
      }
      await keepBlob(tx as unknown as Sql, copy, Date.now())
      return 'ready' as const
    })
  }

  async retain(
    sha256: string,
    bytes: Uint8Array,
    mode: StorageMode,
    target: { farmId: string; agentId: string | null },
  ) {
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
      throw new Error('Library storage unavailable')
  }

  async addVersion(version: NewLibraryVersion, rewrite?: () => Promise<void>) {
    const file: LibraryFile = {
      farmId: version.farmId,
      sha256: version.sha256,
      sizeBytes: version.sizeBytes,
      mode: version.storageLocation,
      agentId: version.agentId,
    }
    await this.sql.begin(async (tx) => {
      // The same locks as the farm library and retention: quota stays exact and
      // a purge cannot run between reviving a record and adding its version.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'library:' + version.farmId}, 0))`
      await lockLibraryBlob(tx as unknown as Sql, version.sha256)
      if (!(await fitsQuota(tx as unknown as Sql, file)))
        throw new LibraryQuotaExceeded()
      await tx`
        INSERT INTO farm.library_items (id, farm_id, title, tags, created_by, created_at)
        VALUES (${version.itemId}::uuid, ${version.farmId}::uuid, ${version.title}, '{}', 'integration', ${version.createdAt})`
      const purged = await tx`
        SELECT 1 FROM farm.library_blobs
        WHERE farm_id = ${file.farmId}::uuid AND sha256 = ${file.sha256} AND storage_location = ${file.mode}
          AND agent_id IS NOT DISTINCT FROM ${file.agentId}::uuid AND purged_at IS NOT NULL`
      await keepBlob(tx as unknown as Sql, file, version.createdAt)
      // Retention may have removed the file after `retain` and before these
      // locks, so write it again while no purge can run. A server file is shared
      // across farms: another farm's purge can take it before this farm has a row.
      if (file.mode === 'server' || purged.length > 0) await rewrite?.()
      // The existing kind constraint only permits G-code and 3MF. The
      // immutable profile in version metadata identifies the resin artifact.
      const storedKind = version.kind === 'resin' ? '3mf' : version.kind
      await tx`
        INSERT INTO farm.library_versions (id, farm_id, item_id, version_number, sha256, size_bytes, storage_location, agent_id, original_name, kind, plate_count, metadata, notes, uploaded_by, created_at)
        VALUES (${version.id}::uuid, ${version.farmId}::uuid, ${version.itemId}::uuid, ${version.versionNumber}, ${version.sha256}, ${version.sizeBytes}, ${version.storageLocation}, ${version.agentId}, ${version.originalName}, ${storedKind}, ${version.plateCount}, ${tx.json(version.resinProfile === undefined ? {} : { resinProfile: version.resinProfile })}, '', 'integration', ${version.createdAt})`
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
