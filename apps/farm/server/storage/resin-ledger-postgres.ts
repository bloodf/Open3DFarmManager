import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import {
  evaluateSession,
  type SessionRecord,
  type AccountSessionState,
  type SessionPolicy,
} from '../utils/auth/session-contract.ts'
import type { ResinLedgerEntry } from '../utils/resin-ledger/entry.ts'
import {
  entryColumns,
  recordFromRow,
  type ResinLedgerRecord,
  type ResinLedgerRow,
} from '../utils/resin-ledger/record.ts'

export interface ResinLedgerAuthority {
  farmId: string
  sessionRecordId: string
  policy: SessionPolicy
}
export class ResinLedgerError extends Error {
  readonly status: number
  constructor(status: number) {
    super('Resin ledger request rejected')
    this.status = status
  }
}
const reject = (status: number): never => {
  throw new ResinLedgerError(status)
}
const uuid = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x)
const LIMIT = 500

export type ResinLedgerOperation =
  | { op: 'list'; printerKey: string }
  | { op: 'record'; printerKey: string; entry: ResinLedgerEntry }

/** Farm-scoped, append-only resin ledger. Members read; owner, admin and operator write. */
export class PostgresResinLedger {
  private readonly sql: Sql
  private readonly clock: () => number
  constructor(sql: Sql, clock: () => number = Date.now) {
    this.sql = sql
    this.clock = clock
  }
  async run(
    authority: ResinLedgerAuthority,
    request: ResinLedgerOperation,
  ): Promise<ResinLedgerRecord[] | { id: string }> {
    if (
      !uuid(authority.farmId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(authority.sessionRecordId) ||
      typeof request.printerKey !== 'string' ||
      request.printerKey.length < 1 ||
      request.printerKey.length > 128
    )
      return reject(400)
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
      const role: unknown =
        members[0]?.revoked_at === null ? members[0]?.role : null
      if (
        typeof role !== 'string' ||
        !['owner', 'admin', 'operator', 'viewer'].includes(role)
      )
        return reject(404)
      if (request.op === 'record' && role === 'viewer') return reject(403)
      const printers =
        await tx`SELECT id FROM farm.printer_assignments WHERE farm_id=${authority.farmId}::uuid AND printer_key=${request.printerKey} AND revoked_at IS NULL`
      const printerId: unknown = printers[0]?.id
      if (!uuid(printerId)) return reject(404)
      let result: ResinLedgerRecord[] | { id: string }
      if (request.op === 'list') {
        const rows = await tx<
          ResinLedgerRow[]
        >`SELECT id, kind, target, name, volume_ml AS "volumeMl", layers::float8 AS layers, hours, source, recorded_at::float8 AS "recordedAt" FROM farm.resin_ledger_entries WHERE farm_id=${authority.farmId}::uuid AND printer_id=${printerId}::uuid ORDER BY recorded_at DESC, id DESC LIMIT ${LIMIT}`
        result = rows.flatMap((row) => recordFromRow(row) ?? [])
      } else {
        const c = entryColumns(request.entry)
        if (c.source !== 'manual') return reject(400)
        const id = randomUUID()
        await tx`INSERT INTO farm.resin_ledger_entries (farm_id,id,printer_id,kind,target,name,volume_ml,layers,hours,source,recorded_at,recorded_by) VALUES (${authority.farmId}::uuid,${id}::uuid,${printerId}::uuid,${c.kind},${c.target},${c.name},${c.volumeMl},${c.layers},${c.hours},${c.source},${now},${decision.accountId})`
        result = { id }
      }
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
}
