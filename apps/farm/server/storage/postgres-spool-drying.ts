import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import {
  evaluateSession,
  type SessionRecord,
  type AccountSessionState,
  type SessionPolicy,
} from '../utils/auth/session-contract.ts'

export interface FeatureAuthority {
  farmId: string
  sessionRecordId: string
  policy: SessionPolicy
}
export type FeatureOperation =
  | 'labels'
  | 'spool'
  | 'drying-list'
  | 'drying-create'
  | 'drying-end'
  | 'humidity-list'
  | 'humidity-create'
export class FeatureError extends Error {
  readonly status: number
  constructor(status: number) {
    super('Spool feature request rejected')
    this.status = status
  }
}
const reject = (status: number): never => {
  throw new FeatureError(status)
}
const id = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x > 0
const time = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
const uuid = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x)
const text = (x: unknown): x is string =>
  typeof x === 'string' && x.length <= 1024 && !x.includes('\0')
const numeric = (x: unknown, min: number, max: number): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max

export class PostgresSpoolDrying {
  private readonly sql: Sql
  private readonly clock: () => number
  constructor(sql: Sql, clock: () => number = Date.now) {
    this.sql = sql
    this.clock = clock
  }
  async run(
    authority: FeatureAuthority,
    operation: FeatureOperation,
    input: Record<string, unknown>,
  ) {
    if (
      !uuid(authority.farmId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(authority.sessionRecordId)
    )
      reject(400)
    return this.sql.begin(async (tx) => {
      const accounts = await tx<
        AccountSessionState[]
      >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id=(SELECT account_id FROM farm.account_sessions WHERE id=${authority.sessionRecordId}) FOR SHARE`
      const sessions = await tx<
        SessionRecord[]
      >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id=${authority.sessionRecordId} FOR UPDATE`
      const now = this.clock()
      const decision = evaluateSession(
        authority.sessionRecordId,
        sessions[0] ?? null,
        accounts[0] ?? null,
        now,
        authority.policy,
      )
      if (!decision.ok) return reject(401)
      const members =
        await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id=${authority.farmId}::uuid AND account_id=${decision.accountId} FOR SHARE`
      const role = members[0]?.revoked_at === null ? members[0]?.role : null
      if (!['owner', 'admin', 'operator', 'viewer'].includes(role))
        return reject(404)
      if (operation.endsWith('create') || operation === 'drying-end')
        if (role === 'viewer') return reject(403)
      const result = await this.execute(tx, authority.farmId, operation, input)
      const after = this.clock()
      if (
        after < now ||
        !evaluateSession(
          authority.sessionRecordId,
          sessions[0] ?? null,
          accounts[0] ?? null,
          after,
          authority.policy,
        ).ok
      )
        return reject(401)
      await tx`UPDATE farm.account_sessions SET last_seen_at=${after} WHERE id=${authority.sessionRecordId}`
      return result
    })
  }
  private async execute(
    tx: TransactionSql,
    farm: string,
    op: FeatureOperation,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (op === 'labels' || op === 'spool') {
      const ids = op === 'spool' ? [input.spoolId] : input.spoolIds
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > 100 ||
        !ids.every(id) ||
        new Set(ids).size !== ids.length
      )
        return reject(400)
      const rows =
        await tx`SELECT s.id::float8 AS id, f.name, f.material, f.color_hex AS "colorHex" FROM farm.spools s JOIN farm.spool_filaments f ON f.farm_id=s.farm_id AND f.id=s.filament_id WHERE s.farm_id=${farm}::uuid AND s.id=ANY(${ids}::bigint[]) ORDER BY s.id`
      if (rows.length !== ids.length) return reject(404)
      return op === 'spool' ? rows[0] : rows
    }
    if (op === 'drying-list') {
      if (!id(input.spoolId)) return reject(400)
      return tx`SELECT id, spool_id::float8 AS "spoolId", started_at::float8 AS "startedAt", ended_at::float8 AS "endedAt", temperature_celsius AS "temperatureCelsius", notes FROM farm.spool_drying_logs WHERE farm_id=${farm}::uuid AND spool_id=${input.spoolId} ORDER BY started_at DESC LIMIT 1000`
    }
    if (op === 'drying-create') {
      if (
        !id(input.spoolId) ||
        !time(input.startedAt) ||
        !(
          input.endedAt === null ||
          (time(input.endedAt) && input.endedAt >= input.startedAt)
        ) ||
        !numeric(input.temperatureCelsius, 0, 300) ||
        !(input.notes === null || text(input.notes))
      )
        return reject(400)
      const rows =
        await tx`INSERT INTO farm.spool_drying_logs (farm_id,id,spool_id,started_at,ended_at,temperature_celsius,notes) SELECT ${farm}::uuid,${randomUUID()}::uuid,s.id,${input.startedAt},${input.endedAt},${input.temperatureCelsius},${input.notes} FROM farm.spools s WHERE s.farm_id=${farm}::uuid AND s.id=${input.spoolId} RETURNING id`
      return rows[0] ?? reject(404)
    }
    if (op === 'drying-end') {
      if (!uuid(input.id) || !time(input.endedAt)) return reject(400)
      const rows =
        await tx`UPDATE farm.spool_drying_logs SET ended_at=${input.endedAt} WHERE farm_id=${farm}::uuid AND id=${input.id}::uuid AND ended_at IS NULL AND started_at<=${input.endedAt} RETURNING id`
      return rows[0] ?? reject(404)
    }
    const slot =
      uuid(input.printerId) &&
      ['printer', 'ams', 'toolhead'].includes(String(input.slotKind)) &&
      Number.isInteger(input.slotIndex) &&
      numeric(input.slotIndex, 0, 1024)
    const noSlot =
      input.printerId == null &&
      input.slotKind == null &&
      input.slotIndex == null
    if (
      (!id(input.spoolId) && input.spoolId != null) ||
      (!slot && !noSlot) ||
      (input.spoolId == null && !slot)
    )
      return reject(400)
    const spoolId = input.spoolId as number | null | undefined
    const printerId = input.printerId as string | null | undefined
    const slotKind = input.slotKind as string | null | undefined
    const slotIndex = input.slotIndex as number | null | undefined
    if (op === 'humidity-list')
      return tx`SELECT id, spool_id::float8 AS "spoolId", printer_id AS "printerId", slot_kind AS "slotKind", slot_index AS "slotIndex", humidity_percent AS "humidityPercent", source, recorded_at::float8 AS "recordedAt" FROM farm.spool_humidity_readings WHERE farm_id=${farm}::uuid AND (${spoolId ?? null}::bigint IS NULL OR spool_id=${spoolId ?? null}) AND (${printerId ?? null}::uuid IS NULL OR (printer_id=${printerId ?? null}::uuid AND slot_kind=${slotKind ?? null} AND slot_index=${slotIndex ?? null})) ORDER BY recorded_at DESC LIMIT 1000`
    if (
      !numeric(input.humidityPercent, 0, 100) ||
      !time(input.recordedAt) ||
      (input.source !== 'manual' && input.source !== 'ams') ||
      (input.source === 'ams' && (!slot || input.slotKind !== 'ams'))
    )
      return reject(400)
    const rows =
      await tx`INSERT INTO farm.spool_humidity_readings (farm_id,id,spool_id,printer_id,slot_kind,slot_index,humidity_percent,source,recorded_at) SELECT ${farm}::uuid,${randomUUID()}::uuid,${spoolId ?? null},${printerId ?? null}::uuid,${slotKind ?? null},${slotIndex ?? null},${input.humidityPercent},${input.source},${input.recordedAt} WHERE (${spoolId ?? null}::bigint IS NULL OR EXISTS (SELECT 1 FROM farm.spools WHERE farm_id=${farm}::uuid AND id=${spoolId ?? null})) AND (${printerId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM farm.printer_assignments WHERE farm_id=${farm}::uuid AND id=${printerId ?? null}::uuid)) RETURNING id`
    return rows[0] ?? reject(404)
  }
}
