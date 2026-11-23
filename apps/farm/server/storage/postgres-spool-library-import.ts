import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionPolicy,
  type SessionRecord,
} from '../utils/auth/session-contract.ts'
import {
  sha256,
  type BundleProblem,
  type ImportBundle,
  type ImportField,
  type ImportFilament,
  type ImportKind,
  type ImportSetting,
  type ImportSpool,
  type ImportVendor,
} from '../utils/spool-library-import/bundle.ts'

export type ImportFormat = 'spoolman-api' | 'json' | 'csv'
export type ImportFailureReason =
  | 'invalid-input'
  | 'unauthorized'
  | 'forbidden'
  | 'denied'
  | 'unresolved-reference'
  | 'busy'
  | 'storage-unavailable'

export interface ImportOptions {
  /** Stable name of the upstream library; identities are scoped to it. */
  sourceKey: string
  format: ImportFormat
  /** Run everything, report, then roll back. */
  dryRun: boolean
  /** A new upstream vendor/filament equal to an unlinked local one: link it, or create a duplicate. */
  onCollision: 'adopt' | 'create'
  /** Upstream and local copy both changed since the last import: keep the local copy, or overwrite. */
  onConflict: 'keep-local' | 'overwrite'
}

export interface Counts {
  created: number
  updated: number
  unchanged: number
  adopted: number
  conflicts: number
}
export interface ImportConflict {
  kind: ImportKind | 'field' | 'setting'
  id: string
}
export interface ImportReport {
  runId: string
  dryRun: boolean
  sourceKey: string
  vendors: Counts
  filaments: Counts
  spools: Counts
  fields: Counts
  settings: Counts
  truncated: number
  skippedSettings: string[]
  conflicts: ImportConflict[]
}
export type ImportResult =
  | { ok: true; report: ImportReport }
  | { ok: false; reason: ImportFailureReason; problems?: BundleProblem[] }

export interface ImportAuthority {
  sessionRecordId: string
  policy: SessionPolicy
  farmId: string
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sessionId = /^[A-Za-z0-9_-]{1,128}$/
export const SOURCE_KEY = /^[a-z0-9][a-z0-9._:-]{0,95}$/
const MAX_CONFLICTS = 50
const MAX_INFLIGHT = 2

class Declined extends Error {
  readonly reason: ImportFailureReason
  readonly problems: BundleProblem[] | undefined
  constructor(reason: ImportFailureReason, problems?: BundleProblem[]) {
    super('declined')
    this.reason = reason
    this.problems = problems
  }
}
class DryRun extends Error {
  readonly report: ImportReport
  constructor(report: ImportReport) {
    super('dry-run')
    this.report = report
  }
}

const zero = (): Counts => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  adopted: 0,
  conflicts: 0,
})

type Row = Record<string, unknown>
const VENDOR_SNAP = `x.id::float8 AS id, x.name, x.comment, x.external_id AS "externalId", x.extra`
const FILAMENT_SNAP = `x.id::float8 AS id, x.vendor_id::float8 AS "vendorId", x.name, x.material, x.color_hex AS "colorHex", x.density, x.diameter, x.weight, x.spool_weight AS "spoolWeight", x.price, x.comment, x.external_id AS "externalId", x.extra`
const SPOOL_SNAP = `x.id::float8 AS id, x.filament_id::float8 AS "filamentId", x.initial_weight AS "initialWeight", x.spool_weight AS "spoolWeight", x.used_weight AS "usedWeight", x.price, x.location, x.lot_nr AS "lotNr", x.comment, x.archived, x.extra, x.first_used_at::float8 AS "firstUsedAt", x.last_used_at::float8 AS "lastUsedAt"`

/** Hash of the locally stored, import-managed columns. */
const snapshot = (row: Row): string => {
  const { id: _id, ...rest } = row
  return sha256(rest)
}

function mapError(error: unknown): ImportFailureReason {
  if (error instanceof Declined) return error.reason
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
  if (code === '55P03' || code === '57014') return 'busy'
  if (code.startsWith('23') || code.startsWith('22')) return 'invalid-input'
  return 'storage-unavailable'
}

interface Identity {
  localId: number
  sourceSha: string
  appliedSha: string
  local: Row
}

/**
 * Applies an `ImportBundle` to one farm in a single transaction. The database
 * role needs only migration 0086 (it has no DELETE anywhere). The failure
 * contract: any failure, including a reference that cannot be resolved or a
 * database error halfway through, rolls back every write of the run; only an
 * audit row with a fixed error code is kept (in a second transaction).
 */
export class PostgresSpoolLibraryImport {
  private inflight = 0
  private readonly sql: Sql
  private readonly clock: () => number

  constructor(sql: Sql, clock: () => number = Date.now) {
    this.sql = sql
    this.clock = clock
  }

  async importBundle(
    authority: ImportAuthority,
    bundle: ImportBundle,
    options: ImportOptions,
  ): Promise<ImportResult> {
    if (
      !uuid.test(authority.farmId) ||
      !sessionId.test(authority.sessionRecordId) ||
      !Number.isSafeInteger(authority.policy.idleTimeoutMs) ||
      authority.policy.idleTimeoutMs <= 0 ||
      !SOURCE_KEY.test(options.sourceKey)
    )
      return { ok: false, reason: 'invalid-input' }
    if (this.inflight >= MAX_INFLIGHT) return { ok: false, reason: 'busy' }
    this.inflight++
    const runId = randomUUID()
    const startedAt = this.clock()
    let actor: string | undefined
    try {
      const report = await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '30s'`
        await tx`SET LOCAL lock_timeout = '25s'`
        const who = await this.authorize(tx, authority)
        actor = who.accountId
        await tx`SELECT pg_advisory_xact_lock(544, hashtext(${authority.farmId + '|' + options.sourceKey}))`
        await tx`INSERT INTO farm.spool_import_runs (farm_id, id, source_key, format, status, actor, started_at)
          VALUES (${authority.farmId}::uuid, ${runId}::uuid, ${options.sourceKey}, ${options.format}, 'completed', ${who.accountId}, ${startedAt})`
        const report = await new Run(
          tx,
          authority.farmId,
          runId,
          who.now,
          bundle,
          options,
        ).apply()
        await tx`UPDATE farm.spool_import_runs SET counts = ${tx.json(report as never)} WHERE farm_id=${authority.farmId}::uuid AND id=${runId}::uuid`
        await this.touch(tx, authority, who.now)
        if (options.dryRun) throw new DryRun(report)
        return report
      })
      return { ok: true, report }
    } catch (error) {
      if (error instanceof DryRun) {
        await this.audit(
          authority,
          runId,
          options,
          'dry-run',
          null,
          actor,
          startedAt,
        )
        return { ok: true, report: error.report }
      }
      const reason = mapError(error)
      // A rolled-back run still leaves a fixed-code audit row, once the caller is known to be authorized.
      if (
        actor &&
        reason !== 'unauthorized' &&
        reason !== 'forbidden' &&
        reason !== 'denied'
      )
        await this.audit(
          authority,
          runId,
          options,
          'failed',
          reason,
          actor,
          startedAt,
        )
      return {
        ok: false,
        reason,
        ...(error instanceof Declined && error.problems
          ? { problems: error.problems }
          : {}),
      }
    } finally {
      this.inflight--
    }
  }

  private async audit(
    authority: ImportAuthority,
    runId: string,
    options: ImportOptions,
    status: 'failed' | 'dry-run',
    code: string | null,
    actor: string | undefined,
    startedAt: number,
  ) {
    if (!actor) return
    await this
      .sql`INSERT INTO farm.spool_import_runs (farm_id, id, source_key, format, status, error_code, actor, started_at)
      VALUES (${authority.farmId}::uuid, ${runId}::uuid, ${options.sourceKey}, ${options.format}, ${status}, ${code}, ${actor}, ${startedAt})`.catch(
      () => {},
    )
  }

  /** Session -> owner/admin of the farm, serialised against revocation. */
  private async authorize(
    tx: TransactionSql,
    input: ImportAuthority,
  ): Promise<{ accountId: string; now: number }> {
    const accounts = await tx<
      AccountSessionState[]
    >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${input.sessionRecordId}) FOR SHARE`
    const sessions = await tx<
      SessionRecord[]
    >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id = ${input.sessionRecordId} FOR UPDATE`
    const now = this.clock()
    const decision = evaluateSession(
      input.sessionRecordId,
      sessions[0] ?? null,
      accounts[0] ?? null,
      now,
      input.policy,
    )
    if (!decision.ok) throw new Declined('unauthorized')
    const members =
      await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${input.farmId}::uuid AND account_id = ${decision.accountId} FOR SHARE`
    const member = members[0]
    if (!member || member.revoked_at !== null) throw new Declined('forbidden')
    if (member.role !== 'owner' && member.role !== 'admin')
      throw new Declined('denied')
    return { accountId: decision.accountId, now }
  }

  private async touch(
    tx: TransactionSql,
    input: ImportAuthority,
    startedAt: number,
  ) {
    const rows = await tx<
      SessionRecord[]
    >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id = ${input.sessionRecordId}`
    const accounts = await tx<
      AccountSessionState[]
    >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = ${rows[0]?.accountId ?? ''}`
    const now = this.clock()
    const current = evaluateSession(
      input.sessionRecordId,
      rows[0] ?? null,
      accounts[0] ?? null,
      now,
      input.policy,
    )
    // The session expired or was revoked while the import ran: nothing is committed.
    if (now < startedAt || !current.ok) throw new Declined('unauthorized')
    await tx`UPDATE farm.account_sessions SET last_seen_at=${current.touchAt} WHERE id=${input.sessionRecordId}`
  }
}

/** One import run inside an open transaction. */
class Run {
  private readonly counts = {
    vendors: zero(),
    filaments: zero(),
    spools: zero(),
    fields: zero(),
    settings: zero(),
  }
  private readonly conflicts: ImportConflict[] = []
  private readonly sp: Sql
  private readonly tx: TransactionSql
  private readonly farmId: string
  private readonly runId: string
  private readonly now: number
  private readonly bundle: ImportBundle
  private readonly options: ImportOptions

  constructor(
    tx: TransactionSql,
    farmId: string,
    runId: string,
    now: number,
    bundle: ImportBundle,
    options: ImportOptions,
  ) {
    this.tx = tx
    this.farmId = farmId
    this.runId = runId
    this.now = now
    this.bundle = bundle
    this.options = options
    this.sp = tx as unknown as Sql
  }

  async apply(): Promise<ImportReport> {
    const vendorIds = new Map<string, number>()
    const filamentIds = new Map<string, number>()
    const vendorIdent = await this.identities(
      'vendor',
      VENDOR_SNAP,
      'spool_vendors',
      'vendor_id',
    )
    const filamentIdent = await this.identities(
      'filament',
      FILAMENT_SNAP,
      'spool_filaments',
      'filament_id',
    )
    const spoolIdent = await this.identities(
      'spool',
      SPOOL_SNAP,
      'spools',
      'spool_id',
    )
    for (const [k, v] of vendorIdent) vendorIds.set(k, v.localId)
    for (const [k, v] of filamentIdent) filamentIds.set(k, v.localId)

    // Every reference must resolve before the first write.
    const problems: BundleProblem[] = []
    const vendorSeen = new Set([
      ...vendorIds.keys(),
      ...this.bundle.vendors.map((v) => v.upstreamId),
    ])
    const filamentSeen = new Set([
      ...filamentIds.keys(),
      ...this.bundle.filaments.map((f) => f.upstreamId),
    ])
    for (const f of this.bundle.filaments)
      if (f.vendorUpstreamId && !vendorSeen.has(f.vendorUpstreamId))
        problems.push({
          path: `filaments[id=${f.upstreamId}].vendor`,
          problem:
            'vendor not in this import or an earlier one from the same source',
        })
    for (const s of this.bundle.spools)
      if (!filamentSeen.has(s.filamentUpstreamId))
        problems.push({
          path: `spools[id=${s.upstreamId}].filament`,
          problem:
            'filament not in this import or an earlier one from the same source',
        })
    if (problems.length > 0)
      throw new Declined('unresolved-reference', problems.slice(0, 20))

    for (const v of this.bundle.vendors)
      await this.vendor(v, vendorIdent, vendorIds)
    for (const f of this.bundle.filaments)
      await this.filament(f, filamentIdent, filamentIds, vendorIds)
    for (const s of this.bundle.spools)
      await this.spool(s, spoolIdent, filamentIds)
    await this.fields(this.bundle.fields)
    await this.settings(this.bundle.settings)

    return {
      runId: this.runId,
      dryRun: this.options.dryRun,
      sourceKey: this.options.sourceKey,
      ...this.counts,
      truncated: this.bundle.truncated,
      skippedSettings: this.bundle.skippedSettings,
      conflicts: this.conflicts,
    }
  }

  private conflict(kind: ImportConflict['kind'], id: string, counts: Counts) {
    counts.conflicts++
    if (this.conflicts.length < MAX_CONFLICTS) this.conflicts.push({ kind, id })
  }

  private async nextId(kind: ImportKind): Promise<number> {
    const rows = await this.sp<{ id: number }[]>`
      INSERT INTO farm.spool_library_counters (farm_id, kind, last_id)
      VALUES (${this.farmId}::uuid, ${kind}, 1)
      ON CONFLICT (farm_id, kind) DO UPDATE SET last_id = farm.spool_library_counters.last_id + 1
      RETURNING last_id::float8 AS id`
    return Number(rows[0]?.id)
  }

  private async identities(
    kind: ImportKind,
    snap: string,
    table: string,
    column: string,
  ): Promise<Map<string, Identity>> {
    const rows = await this.sp<Row[]>`
      SELECT i.upstream_id AS "upstreamId", i.source_sha256 AS "sourceSha", i.applied_sha256 AS "appliedSha", ${this.sp.unsafe(snap)}
      FROM farm.spool_import_identities i
      JOIN ${this.sp.unsafe('farm.' + table)} x ON x.farm_id = i.farm_id AND x.id = i.${this.sp.unsafe(column)}
      WHERE i.farm_id = ${this.farmId}::uuid AND i.source_key = ${this.options.sourceKey} AND i.kind = ${kind}`
    const out = new Map<string, Identity>()
    for (const r of rows) {
      const { upstreamId, sourceSha, appliedSha, ...local } = r
      out.set(String(upstreamId), {
        localId: Number(local['id']),
        sourceSha: String(sourceSha),
        appliedSha: String(appliedSha),
        local,
      })
    }
    return out
  }

  private async link(
    kind: ImportKind,
    upstreamId: string,
    localId: number,
    sourceSha: string,
    appliedSha: string,
  ) {
    const sp = this.sp
    await sp`INSERT INTO farm.spool_import_identities
      (farm_id, source_key, kind, upstream_id, vendor_id, filament_id, spool_id, source_sha256, applied_sha256, first_run_id, updated_run_id)
      VALUES (${this.farmId}::uuid, ${this.options.sourceKey}, ${kind}, ${upstreamId},
        ${kind === 'vendor' ? localId : null}, ${kind === 'filament' ? localId : null}, ${kind === 'spool' ? localId : null},
        ${sourceSha}, ${appliedSha}, ${this.runId}::uuid, ${this.runId}::uuid)`
  }

  private async relink(
    kind: ImportKind,
    upstreamId: string,
    sourceSha: string,
    appliedSha: string,
  ) {
    await this
      .sp`UPDATE farm.spool_import_identities SET source_sha256=${sourceSha}, applied_sha256=${appliedSha}, updated_run_id=${this.runId}::uuid
      WHERE farm_id=${this.farmId}::uuid AND source_key=${this.options.sourceKey} AND kind=${kind} AND upstream_id=${upstreamId}`
  }

  /** Decide unchanged / update / conflict for an upstream record that already has an identity. */
  private decide(
    ident: Identity,
    sourceSha: string,
  ): 'unchanged' | 'update' | 'conflict' {
    if (ident.sourceSha === sourceSha) return 'unchanged'
    return snapshot(ident.local) === ident.appliedSha ||
      this.options.onConflict === 'overwrite'
      ? 'update'
      : 'conflict'
  }

  private async vendor(
    v: ImportVendor,
    idents: Map<string, Identity>,
    ids: Map<string, number>,
  ) {
    const sp = this.sp
    const counts = this.counts.vendors
    const src = sha256(v)
    const ident = idents.get(v.upstreamId)
    if (ident) {
      const verdict = this.decide(ident, src)
      if (verdict === 'unchanged') return void counts.unchanged++
      if (verdict === 'conflict')
        return this.conflict('vendor', v.upstreamId, counts)
      const rows = await sp<
        Row[]
      >`UPDATE farm.spool_vendors AS x SET name=${v.name}, comment=${v.comment}, external_id=${v.externalId}, extra=${sp.json(v.extra as never)}
        WHERE farm_id=${this.farmId}::uuid AND id=${ident.localId} RETURNING ${sp.unsafe(VENDOR_SNAP)}`
      await this.relink('vendor', v.upstreamId, src, snapshot(rows[0] as Row))
      counts.updated++
      return
    }
    if (this.options.onCollision === 'adopt') {
      const found = await sp<
        Row[]
      >`SELECT ${sp.unsafe(VENDOR_SNAP)} FROM farm.spool_vendors x
        WHERE x.farm_id=${this.farmId}::uuid AND lower(x.name)=lower(${v.name})
          AND NOT EXISTS (SELECT 1 FROM farm.spool_import_identities i WHERE i.farm_id=x.farm_id AND i.vendor_id=x.id)
        ORDER BY x.id LIMIT 1`
      if (found[0]) {
        const localId = Number(found[0]['id'])
        await this.link(
          'vendor',
          v.upstreamId,
          localId,
          src,
          snapshot(found[0]),
        )
        ids.set(v.upstreamId, localId)
        counts.adopted++
        return
      }
    }
    const localId = await this.nextId('vendor')
    const rows = await sp<
      Row[]
    >`INSERT INTO farm.spool_vendors AS x (farm_id, id, name, comment, external_id, extra, registered_at)
      VALUES (${this.farmId}::uuid, ${localId}, ${v.name}, ${v.comment}, ${v.externalId}, ${sp.json(v.extra as never)}, ${v.registeredAt ?? this.now})
      RETURNING ${sp.unsafe(VENDOR_SNAP)}`
    await this.link(
      'vendor',
      v.upstreamId,
      localId,
      src,
      snapshot(rows[0] as Row),
    )
    ids.set(v.upstreamId, localId)
    counts.created++
  }

  private async filament(
    f: ImportFilament,
    idents: Map<string, Identity>,
    ids: Map<string, number>,
    vendorIds: Map<string, number>,
  ) {
    const sp = this.sp
    const counts = this.counts.filaments
    const src = sha256(f)
    const vendorId = f.vendorUpstreamId
      ? (vendorIds.get(f.vendorUpstreamId) ?? null)
      : null
    const ident = idents.get(f.upstreamId)
    if (ident) {
      const verdict = this.decide(ident, src)
      if (verdict === 'unchanged') return void counts.unchanged++
      if (verdict === 'conflict')
        return this.conflict('filament', f.upstreamId, counts)
      const rows = await sp<
        Row[]
      >`UPDATE farm.spool_filaments AS x SET vendor_id=${vendorId}, name=${f.name}, material=${f.material}, color_hex=${f.colorHex},
          density=${f.density}, diameter=${f.diameter}, weight=${f.weight}, spool_weight=${f.spoolWeight}, price=${f.price}, comment=${f.comment},
          external_id=${f.externalId}, extra=${sp.json(f.extra as never)}
        WHERE farm_id=${this.farmId}::uuid AND id=${ident.localId} RETURNING ${sp.unsafe(FILAMENT_SNAP)}`
      await this.relink('filament', f.upstreamId, src, snapshot(rows[0] as Row))
      counts.updated++
      return
    }
    if (this.options.onCollision === 'adopt') {
      const found = await sp<
        Row[]
      >`SELECT ${sp.unsafe(FILAMENT_SNAP)} FROM farm.spool_filaments x
        WHERE x.farm_id=${this.farmId}::uuid AND x.vendor_id IS NOT DISTINCT FROM ${vendorId}::bigint
          AND x.name IS NOT DISTINCT FROM ${f.name}::text AND x.material IS NOT DISTINCT FROM ${f.material}::text
          AND lower(x.color_hex) IS NOT DISTINCT FROM lower(${f.colorHex}::text)
          AND x.density=${f.density} AND x.diameter=${f.diameter}
          AND NOT EXISTS (SELECT 1 FROM farm.spool_import_identities i WHERE i.farm_id=x.farm_id AND i.filament_id=x.id)
        ORDER BY x.id LIMIT 1`
      if (found[0]) {
        const localId = Number(found[0]['id'])
        await this.link(
          'filament',
          f.upstreamId,
          localId,
          src,
          snapshot(found[0]),
        )
        ids.set(f.upstreamId, localId)
        counts.adopted++
        return
      }
    }
    const localId = await this.nextId('filament')
    const rows = await sp<
      Row[]
    >`INSERT INTO farm.spool_filaments AS x (farm_id, id, vendor_id, name, material, color_hex, density, diameter, weight, spool_weight, price, comment, external_id, extra, registered_at)
      VALUES (${this.farmId}::uuid, ${localId}, ${vendorId}, ${f.name}, ${f.material}, ${f.colorHex}, ${f.density}, ${f.diameter}, ${f.weight}, ${f.spoolWeight}, ${f.price}, ${f.comment}, ${f.externalId}, ${sp.json(f.extra as never)}, ${f.registeredAt ?? this.now})
      RETURNING ${sp.unsafe(FILAMENT_SNAP)}`
    await this.link(
      'filament',
      f.upstreamId,
      localId,
      src,
      snapshot(rows[0] as Row),
    )
    ids.set(f.upstreamId, localId)
    counts.created++
  }

  private async spool(
    s: ImportSpool,
    idents: Map<string, Identity>,
    filamentIds: Map<string, number>,
  ) {
    const sp = this.sp
    const counts = this.counts.spools
    const src = sha256(s)
    const filamentId = filamentIds.get(s.filamentUpstreamId) as number
    const ident = idents.get(s.upstreamId)
    if (ident) {
      const verdict = this.decide(ident, src)
      if (verdict === 'unchanged') return void counts.unchanged++
      if (verdict === 'conflict')
        return this.conflict('spool', s.upstreamId, counts)
      const rows = await sp<
        Row[]
      >`UPDATE farm.spools AS x SET filament_id=${filamentId}, initial_weight=${s.initialWeight}, spool_weight=${s.spoolWeight}, used_weight=${s.usedWeight},
          price=${s.price}, location=${s.location}, lot_nr=${s.lotNr}, comment=${s.comment}, archived=${s.archived}, extra=${sp.json(s.extra as never)},
          first_used_at=${s.firstUsedAt}, last_used_at=${s.lastUsedAt}
        WHERE farm_id=${this.farmId}::uuid AND id=${ident.localId} RETURNING ${sp.unsafe(SPOOL_SNAP)}`
      await this.relink('spool', s.upstreamId, src, snapshot(rows[0] as Row))
      counts.updated++
      return
    }
    // A spool has no natural key: never merged with an existing local spool.
    const localId = await this.nextId('spool')
    const rows = await sp<
      Row[]
    >`INSERT INTO farm.spools AS x (farm_id, id, filament_id, initial_weight, spool_weight, used_weight, price, location, lot_nr, comment, archived, extra, registered_at, first_used_at, last_used_at)
      VALUES (${this.farmId}::uuid, ${localId}, ${filamentId}, ${s.initialWeight}, ${s.spoolWeight}, ${s.usedWeight}, ${s.price}, ${s.location}, ${s.lotNr}, ${s.comment}, ${s.archived}, ${sp.json(s.extra as never)}, ${s.registeredAt ?? this.now}, ${s.firstUsedAt}, ${s.lastUsedAt})
      RETURNING ${sp.unsafe(SPOOL_SNAP)}`
    await this.link(
      'spool',
      s.upstreamId,
      localId,
      src,
      snapshot(rows[0] as Row),
    )
    counts.created++
  }

  private async fields(fields: ImportField[]) {
    const sp = this.sp
    const counts = this.counts.fields
    const existing = await sp<
      Row[]
    >`SELECT entity_type AS "entityType", key, name, field_type AS "fieldType", sort_order AS "order", unit, default_value AS "defaultValue", choices, multi_choice AS "multiChoice", source_key AS "sourceKey", source_sha256 AS "sourceSha"
      FROM farm.spool_library_fields WHERE farm_id=${this.farmId}::uuid`
    const byKey = new Map(
      existing.map((r) => [`${r['entityType']}/${r['key']}`, r]),
    )
    for (const f of fields) {
      const src = sha256(f)
      const row = byKey.get(`${f.entityType}/${f.key}`)
      const write = async () =>
        sp`UPDATE farm.spool_library_fields SET name=${f.name}, field_type=${f.fieldType}, sort_order=${f.order}, unit=${f.unit}, default_value=${f.defaultValue},
          choices=${f.choices ? sp.json(f.choices as never) : null}, multi_choice=${f.multiChoice}, source_key=${this.options.sourceKey}, source_sha256=${src}, updated_at=${this.now}
          WHERE farm_id=${this.farmId}::uuid AND entity_type=${f.entityType} AND key=${f.key}`
      if (!row) {
        await sp`INSERT INTO farm.spool_library_fields (farm_id, entity_type, key, name, field_type, sort_order, unit, default_value, choices, multi_choice, source_key, source_sha256, updated_at)
          VALUES (${this.farmId}::uuid, ${f.entityType}, ${f.key}, ${f.name}, ${f.fieldType}, ${f.order}, ${f.unit}, ${f.defaultValue}, ${f.choices ? sp.json(f.choices as never) : null}, ${f.multiChoice}, ${this.options.sourceKey}, ${src}, ${this.now})`
        counts.created++
      } else if (row['sourceSha'] === src) counts.unchanged++
      else if (
        row['sourceKey'] === this.options.sourceKey ||
        this.options.onConflict === 'overwrite'
      ) {
        await write()
        counts.updated++
      } else this.conflict('field', `${f.entityType}/${f.key}`, counts)
    }
  }

  private async settings(settings: ImportSetting[]) {
    const sp = this.sp
    const counts = this.counts.settings
    const existing = await sp<
      Row[]
    >`SELECT key, source_key AS "sourceKey", source_sha256 AS "sourceSha" FROM farm.spool_library_settings WHERE farm_id=${this.farmId}::uuid`
    const byKey = new Map(existing.map((r) => [String(r['key']), r]))
    for (const s of settings) {
      const src = sha256(s)
      const row = byKey.get(s.key)
      if (!row) {
        await sp`INSERT INTO farm.spool_library_settings (farm_id, key, value, source_key, source_sha256, updated_at)
          VALUES (${this.farmId}::uuid, ${s.key}, ${sp.json(s.value as never)}, ${this.options.sourceKey}, ${src}, ${this.now})`
        counts.created++
      } else if (row['sourceSha'] === src) counts.unchanged++
      else if (
        row['sourceKey'] === this.options.sourceKey ||
        this.options.onConflict === 'overwrite'
      ) {
        await sp`UPDATE farm.spool_library_settings SET value=${sp.json(s.value as never)}, source_key=${this.options.sourceKey}, source_sha256=${src}, updated_at=${this.now}
          WHERE farm_id=${this.farmId}::uuid AND key=${s.key}`
        counts.updated++
      } else this.conflict('setting', s.key, counts)
    }
  }
}
