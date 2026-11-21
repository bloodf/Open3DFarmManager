import type { Sql, TransactionSql } from 'postgres'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionPolicy,
  type SessionRecord,
} from '../utils/auth/session-contract.ts'
import type {
  LegacyCredentialSummary,
  PageInput,
  Result,
  Spool,
  SpoolFilament,
  SpoolFilamentInput,
  SpoolEntityType,
  SpoolExtraFieldDefinition,
  SpoolInput,
  SpoolLibraryAccess,
  SpoolLibraryAuthority,
  SpoolLibraryFailure,
  SpoolLibraryFailureReason,
  SpoolLibraryRepository,
  SpoolLibraryStorage,
  SpoolRecordId,
  SpoolVendor,
  SpoolVendorInput,
} from '../utils/spool-library/scope.ts'
import {
  DECOY_SHA256,
  issueLegacyToken,
  parseLegacyToken,
  secretMatches,
} from './spool-library-credential.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sessionId = /^[A-Za-z0-9_-]{1,128}$/
const MAX_INFLIGHT = { session: 32, legacy: 16 } as const
const MAX_PAGE = 500
const MAX_ACTIVE_CREDENTIALS = 16
/** Upstream: 128 extra fields per entity, 65535 characters each (migration 0087 bound). */
const MAX_EXTRA_JSON = 9_000_000
const optInt = (v: unknown) =>
  v === undefined ||
  v === null ||
  (Number.isSafeInteger(v) && (v as number) >= 0)
const COLOR = '[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?'
const MULTI_COLOR = new RegExp(`^${COLOR}(,${COLOR})+$`)
/** Credential last-use stamps are throttled so reads do not become writes. */
const LAST_USED_GRANULARITY_MS = 60_000

const fail = (reason: SpoolLibraryFailureReason): SpoolLibraryFailure => ({
  ok: false,
  reason,
})
const ok = <T>(value: T): Result<T> => ({ ok: true, value })

interface Resolved {
  farmId: string
  access: SpoolLibraryAccess
  actor: string
  now: number
}

const roleAccess = (role: string): SpoolLibraryAccess | null =>
  role === 'owner' || role === 'admin'
    ? 'manage'
    : role === 'operator'
      ? 'write'
      : role === 'viewer'
        ? 'read'
        : null

/** PostgreSQL error classes that mean the caller's data was rejected, not an outage. */
function mapDatabaseError(error: unknown): SpoolLibraryFailure {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
  if (code === '23503') return fail('conflict')
  if (code === '23505') return fail('conflict')
  if (code.startsWith('23') || code.startsWith('22'))
    return fail('invalid-input')
  return fail('storage-unavailable')
}

const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max
const optText = (v: unknown, max: number) =>
  v === undefined || v === null || (typeof v === 'string' && v.length <= max)
const isNum = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min
const optNum = (v: unknown, min: number) =>
  v === undefined || v === null || isNum(v, min)
const optId = (v: unknown) =>
  v === undefined ||
  v === null ||
  (Number.isSafeInteger(v) && (v as number) >= 1)
const validExtra = (v: unknown) =>
  v === undefined ||
  (typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    JSON.stringify(v).length <= MAX_EXTRA_JSON)
const validId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1

const VENDOR = `id::float8 AS id, name, comment, empty_spool_weight AS "emptySpoolWeight", external_id AS "externalId", extra, registered_at::float8 AS "registeredAt"`
const FILAMENT = `id::float8 AS id, vendor_id::float8 AS "vendorId", name, material, color_hex AS "colorHex", multi_color_hexes AS "multiColorHexes", multi_color_direction AS "multiColorDirection", article_number AS "articleNumber", settings_extruder_temp::float8 AS "settingsExtruderTemp", settings_bed_temp::float8 AS "settingsBedTemp", density, diameter, weight, spool_weight AS "spoolWeight", price, comment, external_id AS "externalId", extra, registered_at::float8 AS "registeredAt"`
const SPOOL = `id::float8 AS id, filament_id::float8 AS "filamentId", initial_weight AS "initialWeight", spool_weight AS "spoolWeight", used_weight AS "usedWeight", price, location, lot_nr AS "lotNr", comment, archived, extra, registered_at::float8 AS "registeredAt", first_used_at::float8 AS "firstUsedAt", last_used_at::float8 AS "lastUsedAt"`

type Row = Record<string, unknown>
const SNAKE: Record<string, string> = {
  externalId: 'external_id',
  emptySpoolWeight: 'empty_spool_weight',
  multiColorHexes: 'multi_color_hexes',
  multiColorDirection: 'multi_color_direction',
  articleNumber: 'article_number',
  settingsExtruderTemp: 'settings_extruder_temp',
  settingsBedTemp: 'settings_bed_temp',
  vendorId: 'vendor_id',
  colorHex: 'color_hex',
  spoolWeight: 'spool_weight',
  filamentId: 'filament_id',
  initialWeight: 'initial_weight',
  usedWeight: 'used_weight',
  lotNr: 'lot_nr',
  firstUsedAt: 'first_used_at',
  lastUsedAt: 'last_used_at',
}
/** Column-name row of only the fields the caller supplied. */
function columns(input: object, allowed: readonly string[], sp: Sql): Row {
  const out: Row = {}
  for (const key of allowed) {
    const value = (input as Row)[key]
    if (value === undefined) continue
    out[SNAKE[key] ?? key] = key === 'extra' ? sp.json(value as never) : value
  }
  return out
}

/**
 * Farm-scoped repository. `farm` is fixed at construction from a resolved
 * authority and is the only farm any statement below can touch.
 */
class ScopedRepository implements SpoolLibraryRepository {
  readonly farmId: string
  readonly access: SpoolLibraryAccess
  private readonly tx: TransactionSql
  private readonly now: number

  constructor(tx: TransactionSql, resolved: Resolved) {
    this.tx = tx
    this.farmId = resolved.farmId
    this.access = resolved.access
    this.now = resolved.now
  }

  private writable(): boolean {
    return this.access === 'write' || this.access === 'manage'
  }

  /** One savepoint per operation: a rejected statement never poisons the transaction. */
  private async guarded<T>(
    mutates: boolean,
    work: (sp: Sql) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (mutates && !this.writable()) return fail('denied')
    try {
      return await this.tx.savepoint(async (sp) => {
        const result = await work(sp as unknown as Sql)
        if (!result.ok) throw new Declined(result)
        return result
      })
    } catch (error) {
      return error instanceof Declined ? error.failure : mapDatabaseError(error)
    }
  }

  private async nextId(
    sp: Sql,
    kind: 'vendor' | 'filament' | 'spool',
  ): Promise<number> {
    const rows = await sp<{ id: number }[]>`
      INSERT INTO farm.spool_library_counters (farm_id, kind, last_id)
      VALUES (${this.farmId}::uuid, ${kind}, 1)
      ON CONFLICT (farm_id, kind) DO UPDATE SET last_id = farm.spool_library_counters.last_id + 1
      RETURNING last_id::float8 AS id`
    return Number(rows[0]?.id)
  }

  private page(page: PageInput): { limit: number; after: number } | null {
    if (
      !Number.isSafeInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > MAX_PAGE ||
      !(
        page.afterId === undefined ||
        validId(page.afterId) ||
        page.afterId === 0
      )
    )
      return null
    return { limit: page.limit, after: page.afterId ?? 0 }
  }

  readonly extraFields = {
    list: (entity: SpoolEntityType) =>
      this.guarded(false, async (sp) => {
        if (!['vendor', 'filament', 'spool'].includes(entity))
          return fail('invalid-input')
        return ok(
          await sp<
            SpoolExtraFieldDefinition[]
          >`SELECT entity_type AS "entityType", key, name, field_type AS "fieldType", sort_order AS "order", unit, default_value AS "defaultValue", choices, multi_choice AS "multiChoice" FROM farm.spool_library_fields WHERE farm_id=${this.farmId}::uuid AND entity_type=${entity} ORDER BY key LIMIT 256`,
        )
      }),
  }

  readonly vendors = {
    list: (page: PageInput) => {
      const p = this.page(page)
      if (!p) return Promise.resolve(fail('invalid-input'))
      return this.guarded(false, async (sp) =>
        ok(
          await sp<
            SpoolVendor[]
          >`SELECT ${sp.unsafe(VENDOR)} FROM farm.spool_vendors WHERE farm_id=${this.farmId}::uuid AND id>${p.after} ORDER BY id LIMIT ${p.limit}`,
        ),
      )
    },
    get: (id: SpoolRecordId) =>
      this.guarded(false, async (sp) => {
        if (!validId(id)) return fail('not-found')
        const rows = await sp<
          SpoolVendor[]
        >`SELECT ${sp.unsafe(VENDOR)} FROM farm.spool_vendors WHERE farm_id=${this.farmId}::uuid AND id=${id}`
        return rows[0] ? ok(rows[0]) : fail('not-found')
      }),
    create: (input: SpoolVendorInput) =>
      this.guarded(true, async (sp) => {
        if (
          !isText(input.name, 256) ||
          !optText(input.comment, 1024) ||
          !optNum(input.emptySpoolWeight, 0) ||
          !optText(input.externalId, 256) ||
          !validExtra(input.extra)
        )
          return fail('invalid-input')
        const id = await this.nextId(sp, 'vendor')
        const rows = await sp<SpoolVendor[]>`
          INSERT INTO farm.spool_vendors (farm_id, id, name, comment, empty_spool_weight, external_id, extra, registered_at)
          VALUES (${this.farmId}::uuid, ${id}, ${input.name}, ${input.comment ?? null}, ${input.emptySpoolWeight ?? null}, ${input.externalId ?? null}, ${sp.json((input.extra ?? {}) as never)}, ${this.now})
          RETURNING ${sp.unsafe(VENDOR)}`
        return rows[0] ? ok(rows[0]) : fail('storage-unavailable')
      }),
    update: (id: SpoolRecordId, patch: Partial<SpoolVendorInput>) =>
      this.guarded(true, async (sp) => {
        if (
          !validId(id) ||
          (patch.name !== undefined && !isText(patch.name, 256)) ||
          !optText(patch.comment, 1024) ||
          !optNum(patch.emptySpoolWeight, 0) ||
          !optText(patch.externalId, 256) ||
          !validExtra(patch.extra)
        )
          return fail('invalid-input')
        const set = columns(
          patch,
          ['name', 'comment', 'emptySpoolWeight', 'externalId', 'extra'],
          sp,
        )
        const rows = Object.keys(set).length
          ? await sp<
              SpoolVendor[]
            >`UPDATE farm.spool_vendors SET ${sp(set)} WHERE farm_id=${this.farmId}::uuid AND id=${id} RETURNING ${sp.unsafe(VENDOR)}`
          : await sp<
              SpoolVendor[]
            >`SELECT ${sp.unsafe(VENDOR)} FROM farm.spool_vendors WHERE farm_id=${this.farmId}::uuid AND id=${id}`
        return rows[0] ? ok(rows[0]) : fail('not-found')
      }),
    delete: (id: SpoolRecordId) =>
      this.guarded(true, async (sp) => {
        if (!validId(id)) return fail('not-found')
        // Upstream clears the vendor of every filament that referred to it.
        await sp`UPDATE farm.spool_filaments SET vendor_id=NULL WHERE farm_id=${this.farmId}::uuid AND vendor_id=${id}`
        const rows =
          await sp`DELETE FROM farm.spool_vendors WHERE farm_id=${this.farmId}::uuid AND id=${id} RETURNING id`
        return rows[0] ? ok(true as const) : fail('not-found')
      }),
  }

  private filamentValid(input: Partial<SpoolFilamentInput>, full: boolean) {
    return (
      (!full ||
        (isNum(input.density, 0) &&
          input.density > 0 &&
          isNum(input.diameter, 0) &&
          input.diameter > 0)) &&
      (full ||
        input.density === undefined ||
        (isNum(input.density, 0) && input.density > 0)) &&
      (full ||
        input.diameter === undefined ||
        (isNum(input.diameter, 0) && input.diameter > 0)) &&
      optId(input.vendorId) &&
      optText(input.name, 256) &&
      optText(input.material, 64) &&
      (input.colorHex === undefined ||
        input.colorHex === null ||
        /^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(input.colorHex)) &&
      (input.multiColorHexes === undefined ||
        input.multiColorHexes === null ||
        (input.multiColorHexes.length <= 4096 &&
          MULTI_COLOR.test(input.multiColorHexes))) &&
      (input.multiColorDirection === undefined ||
        input.multiColorDirection === null ||
        input.multiColorDirection === 'coaxial' ||
        input.multiColorDirection === 'longitudinal') &&
      optText(input.articleNumber, 256) &&
      optInt(input.settingsExtruderTemp) &&
      optInt(input.settingsBedTemp) &&
      (input.weight === undefined ||
        input.weight === null ||
        (isNum(input.weight, 0) && input.weight > 0)) &&
      optNum(input.spoolWeight, 0) &&
      optNum(input.price, 0) &&
      optText(input.comment, 1024) &&
      optText(input.externalId, 256) &&
      validExtra(input.extra)
    )
  }

  readonly filaments = {
    list: (page: PageInput) => {
      const p = this.page(page)
      if (!p) return Promise.resolve(fail('invalid-input'))
      return this.guarded(false, async (sp) =>
        ok(
          await sp<
            SpoolFilament[]
          >`SELECT ${sp.unsafe(FILAMENT)} FROM farm.spool_filaments WHERE farm_id=${this.farmId}::uuid AND id>${p.after} ORDER BY id LIMIT ${p.limit}`,
        ),
      )
    },
    get: (id: SpoolRecordId) =>
      this.guarded(false, async (sp) => {
        if (!validId(id)) return fail('not-found')
        const rows = await sp<
          SpoolFilament[]
        >`SELECT ${sp.unsafe(FILAMENT)} FROM farm.spool_filaments WHERE farm_id=${this.farmId}::uuid AND id=${id}`
        return rows[0] ? ok(rows[0]) : fail('not-found')
      }),
    create: (input: SpoolFilamentInput) =>
      this.guarded(true, async (sp) => {
        if (!this.filamentValid(input, true)) return fail('invalid-input')
        const id = await this.nextId(sp, 'filament')
        const rows = await sp<SpoolFilament[]>`
          INSERT INTO farm.spool_filaments (farm_id, id, vendor_id, name, material, color_hex, multi_color_hexes, multi_color_direction, article_number, settings_extruder_temp, settings_bed_temp, density, diameter, weight, spool_weight, price, comment, external_id, extra, registered_at)
          VALUES (${this.farmId}::uuid, ${id}, ${input.vendorId ?? null}, ${input.name ?? null}, ${input.material ?? null}, ${input.colorHex ?? null}, ${input.multiColorHexes ?? null}, ${input.multiColorDirection ?? null}, ${input.articleNumber ?? null}, ${input.settingsExtruderTemp ?? null}, ${input.settingsBedTemp ?? null}, ${input.density}, ${input.diameter}, ${input.weight ?? null}, ${input.spoolWeight ?? null}, ${input.price ?? null}, ${input.comment ?? null}, ${input.externalId ?? null}, ${sp.json((input.extra ?? {}) as never)}, ${this.now})
          RETURNING ${sp.unsafe(FILAMENT)}`
        return rows[0] ? ok(rows[0]) : fail('storage-unavailable')
      }),
    update: (id: SpoolRecordId, patch: Partial<SpoolFilamentInput>) =>
      this.guarded(true, async (sp) => {
        if (!validId(id) || !this.filamentValid(patch, false))
          return fail('invalid-input')
        const set = columns(
          patch,
          [
            'vendorId',
            'name',
            'material',
            'colorHex',
            'multiColorHexes',
            'multiColorDirection',
            'articleNumber',
            'settingsExtruderTemp',
            'settingsBedTemp',
            'density',
            'diameter',
            'weight',
            'spoolWeight',
            'price',
            'comment',
            'externalId',
            'extra',
          ],
          sp,
        )
        const rows = Object.keys(set).length
          ? await sp<
              SpoolFilament[]
            >`UPDATE farm.spool_filaments SET ${sp(set)} WHERE farm_id=${this.farmId}::uuid AND id=${id} RETURNING ${sp.unsafe(FILAMENT)}`
          : await sp<
              SpoolFilament[]
            >`SELECT ${sp.unsafe(FILAMENT)} FROM farm.spool_filaments WHERE farm_id=${this.farmId}::uuid AND id=${id}`
        return rows[0] ? ok(rows[0]) : fail('not-found')
      }),
    delete: (id: SpoolRecordId) =>
      this.guarded(true, async (sp) => {
        if (!validId(id)) return fail('not-found')
        const rows =
          await sp`DELETE FROM farm.spool_filaments WHERE farm_id=${this.farmId}::uuid AND id=${id} RETURNING id`
        return rows[0] ? ok(true as const) : fail('not-found')
      }),
  }

  private spoolValid(input: Partial<SpoolInput>, full: boolean) {
    return (
      (full
        ? validId(input.filamentId)
        : input.filamentId === undefined || validId(input.filamentId)) &&
      optNum(input.initialWeight, 0) &&
      optNum(input.spoolWeight, 0) &&
      (input.usedWeight === undefined || isNum(input.usedWeight, 0)) &&
      optNum(input.price, 0) &&
      optText(input.location, 256) &&
      optText(input.lotNr, 256) &&
      optText(input.comment, 1024) &&
      (input.archived === undefined || typeof input.archived === 'boolean') &&
      optInt(input.firstUsedAt) &&
      optInt(input.lastUsedAt) &&
      validExtra(input.extra)
    )
  }

  readonly spools = {
    list: (page: PageInput) => {
      const p = this.page(page)
      if (!p) return Promise.resolve(fail('invalid-input'))
      return this.guarded(false, async (sp) =>
        ok(
          await sp<
            Spool[]
          >`SELECT ${sp.unsafe(SPOOL)} FROM farm.spools WHERE farm_id=${this.farmId}::uuid AND id>${p.after} ORDER BY id LIMIT ${p.limit}`,
        ),
      )
    },
    get: (id: SpoolRecordId) =>
      this.guarded(false, async (sp) => {
        if (!validId(id)) return fail('not-found')
        const rows = await sp<
          Spool[]
        >`SELECT ${sp.unsafe(SPOOL)} FROM farm.spools WHERE farm_id=${this.farmId}::uuid AND id=${id}`
        return rows[0] ? ok(rows[0]) : fail('not-found')
      }),
    create: (input: SpoolInput) =>
      this.guarded(true, async (sp) => {
        if (!this.spoolValid(input, true)) return fail('invalid-input')
        const id = await this.nextId(sp, 'spool')
        const rows = await sp<Spool[]>`
          INSERT INTO farm.spools (farm_id, id, filament_id, initial_weight, spool_weight, used_weight, price, location, lot_nr, comment, archived, extra, registered_at, first_used_at, last_used_at)
          VALUES (${this.farmId}::uuid, ${id}, ${input.filamentId}, ${input.initialWeight ?? null}, ${input.spoolWeight ?? null}, ${input.usedWeight ?? 0}, ${input.price ?? null}, ${input.location ?? null}, ${input.lotNr ?? null}, ${input.comment ?? null}, ${input.archived ?? false}, ${sp.json((input.extra ?? {}) as never)}, ${this.now}, ${input.firstUsedAt ?? null}, ${input.lastUsedAt ?? null})
          RETURNING ${sp.unsafe(SPOOL)}`
        return rows[0] ? ok(rows[0]) : fail('storage-unavailable')
      }),
    update: (id: SpoolRecordId, patch: Partial<SpoolInput>) =>
      this.guarded(true, async (sp) => {
        if (!validId(id) || !this.spoolValid(patch, false))
          return fail('invalid-input')
        const set = columns(
          patch,
          [
            'filamentId',
            'initialWeight',
            'spoolWeight',
            'usedWeight',
            'price',
            'location',
            'lotNr',
            'comment',
            'archived',
            'firstUsedAt',
            'lastUsedAt',
            'extra',
          ],
          sp,
        )
        const rows = Object.keys(set).length
          ? await sp<
              Spool[]
            >`UPDATE farm.spools SET ${sp(set)} WHERE farm_id=${this.farmId}::uuid AND id=${id} RETURNING ${sp.unsafe(SPOOL)}`
          : await sp<
              Spool[]
            >`SELECT ${sp.unsafe(SPOOL)} FROM farm.spools WHERE farm_id=${this.farmId}::uuid AND id=${id}`
        return rows[0] ? ok(rows[0]) : fail('not-found')
      }),
    delete: (id: SpoolRecordId) =>
      this.guarded(true, async (sp) => {
        if (!validId(id)) return fail('not-found')
        const rows =
          await sp`DELETE FROM farm.spools WHERE farm_id=${this.farmId}::uuid AND id=${id} RETURNING id`
        return rows[0] ? ok(true as const) : fail('not-found')
      }),
    use: (id: SpoolRecordId, grams: number) =>
      this.guarded(true, async (sp) => {
        if (
          !validId(id) ||
          typeof grams !== 'number' ||
          !Number.isFinite(grams)
        )
          return fail('invalid-input')
        const rows = await sp<Spool[]>`
          UPDATE farm.spools
          SET used_weight = CASE WHEN used_weight + ${grams} >= 0.0 THEN used_weight + ${grams} ELSE 0.0 END,
            first_used_at = COALESCE(first_used_at, ${this.now}), last_used_at = ${this.now}
          WHERE farm_id=${this.farmId}::uuid AND id=${id} RETURNING ${sp.unsafe(SPOOL)}`
        return rows[0] ? ok(rows[0]) : fail('not-found')
      }),
  }
}

class Declined extends Error {
  readonly failure: SpoolLibraryFailure
  constructor(failure: SpoolLibraryFailure) {
    super('declined')
    this.failure = failure
  }
}

interface SessionInput {
  sessionRecordId: string
  policy: SessionPolicy
  farmId: string
}

/**
 * PostgreSQL implementation. Its database role needs only migration 0085
 * (see validateSpoolLibraryRole). It never logs, and its failures carry fixed
 * reasons only: no token, hash or driver message is ever returned.
 */
export class PostgresSpoolLibrary implements SpoolLibraryStorage {
  private readonly inflight = { session: 0, legacy: 0 }
  private readonly sql: Sql
  private readonly clock: () => number

  constructor(sql: Sql, clock: () => number = Date.now) {
    this.sql = sql
    this.clock = clock
  }

  /**
   * One transaction per call. A returned failure is thrown inside the
   * transaction so everything the work wrote is rolled back: a scope either
   * commits completely or not at all. Unauthenticated legacy traffic has its
   * own, smaller budget so it cannot starve signed-in members.
   */
  private async transact<T>(
    budget: 'session' | 'legacy',
    body: (tx: TransactionSql) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (this.inflight[budget] >= MAX_INFLIGHT[budget])
      return fail('storage-unavailable')
    this.inflight[budget]++
    try {
      return await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const result = await body(tx)
        if (!result.ok) throw new Declined(result)
        return result
      })
    } catch (error) {
      return error instanceof Declined
        ? error.failure
        : fail('storage-unavailable')
    } finally {
      this.inflight[budget]--
    }
  }

  /** Member session -> farm access, serialised against revocation; touches the session. */
  private async withSession<T>(
    input: SessionInput,
    work: (tx: TransactionSql, resolved: Resolved) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (
      !uuid.test(input.farmId) ||
      !sessionId.test(input.sessionRecordId) ||
      !Number.isSafeInteger(input.policy.idleTimeoutMs) ||
      input.policy.idleTimeoutMs <= 0
    )
      return fail('invalid-input')
    return this.transact('session', async (tx) => {
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
      if (!first.ok) return fail('unauthorized')
      const members =
        await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${input.farmId}::uuid AND account_id = ${first.accountId} FOR SHARE`
      const access =
        members[0] && members[0].revoked_at === null
          ? roleAccess(String(members[0].role))
          : null
      if (!access) return fail('forbidden')
      const result = await work(tx, {
        farmId: input.farmId,
        access,
        actor: first.accountId,
        now: firstAt,
      })
      const now = this.clock()
      const current = evaluateSession(
        input.sessionRecordId,
        sessions[0] ?? null,
        accounts[0] ?? null,
        now,
        input.policy,
      )
      if (now < firstAt || !current.ok) return fail('unauthorized')
      await tx`UPDATE farm.account_sessions SET last_seen_at=${current.touchAt} WHERE id=${input.sessionRecordId}`
      return result
    })
  }

  /** Legacy URL credential -> the one farm it was issued for. Uniform failure. */
  private async withLegacy<T>(
    token: string,
    work: (tx: TransactionSql, resolved: Resolved) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const parsed = parseLegacyToken(token)
    if (!parsed) return fail('unauthorized')
    return this.transact('legacy', async (tx) => {
      const rows = await tx<
        {
          farmId: string
          access: string
          secretSha256: string
        }[]
      >`SELECT farm_id AS "farmId", access, secret_sha256 AS "secretSha256" FROM farm.spool_library_credentials WHERE id=${parsed.credentialId}::uuid AND revoked_at IS NULL`
      const row = rows[0]
      // Always compare, so an unknown id costs the same as a wrong secret.
      const matched = secretMatches(
        parsed.secret,
        row?.secretSha256 ?? DECOY_SHA256,
      )
      if (!row || !matched || (row.access !== 'read' && row.access !== 'write'))
        return fail('unauthorized')
      const now = this.clock()
      // One conditional statement: no read lock to upgrade, so concurrent
      // first requests queue on the row instead of deadlocking.
      await tx`UPDATE farm.spool_library_credentials SET last_used_at=${now} WHERE id=${parsed.credentialId}::uuid AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at <= ${now - LAST_USED_GRANULARITY_MS})`
      return work(tx, {
        farmId: row.farmId,
        access: row.access,
        actor: `legacy:${parsed.credentialId}`,
        now,
      })
    })
  }

  withScope<T>(
    authority: SpoolLibraryAuthority,
    work: (repository: SpoolLibraryRepository) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const run = (tx: TransactionSql, resolved: Resolved) =>
      work(new ScopedRepository(tx, resolved))
    return authority.kind === 'session'
      ? this.withSession(authority, run)
      : this.withLegacy(authority.token, run)
  }

  private manage<T>(
    input: SessionInput,
    work: (tx: TransactionSql, resolved: Resolved) => Promise<Result<T>>,
  ) {
    return this.withSession(input, async (tx, resolved) =>
      resolved.access === 'manage' ? work(tx, resolved) : fail('denied'),
    )
  }

  issueLegacyCredential(
    input: SessionInput & { label: string; access: 'read' | 'write' },
  ): Promise<Result<{ credential: LegacyCredentialSummary; token: string }>> {
    if (
      typeof input.label !== 'string' ||
      input.label !== input.label.trim() ||
      input.label.length < 1 ||
      input.label.length > 64 ||
      (input.access !== 'read' && input.access !== 'write')
    )
      return Promise.resolve(fail('invalid-input'))
    return this.manage(input, async (tx, resolved) => {
      // Serialise issuers per farm so the cap cannot be raced past.
      await tx`SELECT pg_advisory_xact_lock(541, hashtext(${resolved.farmId}))`
      const active = await tx<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM farm.spool_library_credentials WHERE farm_id=${resolved.farmId}::uuid AND revoked_at IS NULL`
      if ((active[0]?.n ?? 0) >= MAX_ACTIVE_CREDENTIALS) return fail('limit')
      const issued = issueLegacyToken()
      await tx`INSERT INTO farm.spool_library_credentials (id, farm_id, label, access, secret_sha256, created_by, created_at)
        VALUES (${issued.credentialId}::uuid, ${resolved.farmId}::uuid, ${input.label}, ${input.access}, ${issued.secretSha256}, ${resolved.actor}, ${resolved.now})`
      return ok({
        token: issued.token,
        credential: {
          id: issued.credentialId,
          label: input.label,
          access: input.access,
          createdAt: resolved.now,
          lastUsedAt: null,
          revokedAt: null,
        },
      })
    })
  }

  listLegacyCredentials(input: SessionInput) {
    return this.manage(input, async (tx, resolved) =>
      ok(
        await tx<
          LegacyCredentialSummary[]
        >`SELECT id, label, access, created_at::float8 AS "createdAt", last_used_at::float8 AS "lastUsedAt", revoked_at::float8 AS "revokedAt" FROM farm.spool_library_credentials WHERE farm_id=${resolved.farmId}::uuid ORDER BY created_at, id LIMIT 100`,
      ),
    )
  }

  revokeLegacyCredential(input: SessionInput & { credentialId: string }) {
    if (!uuid.test(input.credentialId))
      return Promise.resolve(fail('invalid-input'))
    return this.manage(input, async (tx, resolved) => {
      const rows =
        await tx`UPDATE farm.spool_library_credentials SET revoked_at=COALESCE(revoked_at, ${resolved.now}) WHERE id=${input.credentialId}::uuid AND farm_id=${resolved.farmId}::uuid RETURNING id`
      return rows[0] ? ok(true as const) : fail('not-found')
    })
  }
}
