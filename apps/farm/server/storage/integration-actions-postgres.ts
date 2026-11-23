import type { Sql } from 'postgres'
import type {
  ActionRecord,
  ActionTarget,
  CreateActionOutcome,
  IntegrationActionsStore,
  NewAction,
} from '../services/integration-actions.ts'
import type { EnvelopeRecord } from '../services/integration-delivery.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const actionColumns = (sql: Sql) =>
  sql`a.id::text AS "id", a.app_id::text AS "appId", a.grant_id::text AS "grantId", a.farm_id::text AS "farmId", a.printer_assignment_id::text AS "printerAssignmentId", a.idempotency_key AS "idempotencyKey", a.request_hash AS "requestHash", a.action, a.required_scope AS "requiredScope", a.status, a.created_at::float8 AS "createdAt", a.updated_at::float8 AS "updatedAt"`
const envelopeColumns = (sql: Sql) =>
  sql`e.cmd_id::text AS "cmdId", e.app_id::text AS "appId", e.grant_id::text AS "grantId", e.farm_id::text AS "farmId", e.agent_id::text AS "agentId", e.printer_assignment_id::text AS "printerAssignmentId", e.kind, e.resource_id::text AS "resourceId", e.required_scope AS "requiredScope", e.nonce, e.wire, e.issued_at::float8 AS "issuedAt", e.expires_at::float8 AS "expiresAt", e.status, e.refusal_code AS "refusalCode", e.result_detail AS "resultDetail", e.history_entry_id AS "historyEntryId", e.created_at::float8 AS "createdAt", e.updated_at::float8 AS "updatedAt"`

/** Least privilege is supplied by farm_integration_jobs, shared with the action API. */
export class PostgresIntegrationActions implements IntegrationActionsStore {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }

  async target(printerAssignmentId: string): Promise<ActionTarget | null> {
    if (!uuid.test(printerAssignmentId)) return null
    const rows = await this.sql<ActionTarget[]>`
      SELECT p.farm_id::text AS "farmId", p.agent_id::text AS "agentId",
        s.state->'controls' AS controls
      FROM farm.printer_assignments p
      LEFT JOIN farm.printer_latest_state s
        ON s.farm_id = p.farm_id AND s.agent_id = p.agent_id AND s.printer_key = p.printer_key
      WHERE p.id = ${printerAssignmentId}::uuid AND p.revoked_at IS NULL`
    const row = rows[0]
    if (!row) return null
    const controls = Array.isArray(row.controls)
      ? row.controls.filter((item): item is string => typeof item === 'string')
      : null
    return { farmId: row.farmId, agentId: row.agentId, controls }
  }

  async existing(appId: string, idempotencyKey: string) {
    if (!uuid.test(appId)) return null
    const rows = await this.sql<{ id: string }[]>`
      SELECT id::text AS id FROM farm.integration_actions
      WHERE app_id = ${appId}::uuid AND idempotency_key = ${idempotencyKey}`
    return rows[0] ? this.get(rows[0].id, appId) : null
  }

  async create(action: NewAction, now: number): Promise<CreateActionOutcome> {
    try {
      return await this.sql.begin(async (tx): Promise<CreateActionOutcome> => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const inserted = await tx<ActionRecord[]>`
          INSERT INTO farm.integration_actions
            (id, app_id, grant_id, farm_id, printer_assignment_id, idempotency_key, request_hash, action, required_scope, status, created_at, updated_at)
          VALUES
            (${action.id}::uuid, ${action.appId}::uuid, ${action.grantId}::uuid, ${action.farmId}::uuid, ${action.printerAssignmentId}::uuid, ${action.idempotencyKey}, ${action.requestHash}, ${tx.json(action.action)}, ${action.requiredScope}, ${action.status}, ${now}, ${now})
          ON CONFLICT (app_id, idempotency_key) DO NOTHING
          RETURNING id::text AS "id", app_id::text AS "appId", grant_id::text AS "grantId", farm_id::text AS "farmId", printer_assignment_id::text AS "printerAssignmentId", idempotency_key AS "idempotencyKey", request_hash AS "requestHash", action, required_scope AS "requiredScope", status, created_at::float8 AS "createdAt", updated_at::float8 AS "updatedAt"`
        if (inserted[0]) {
          const record = { ...inserted[0] }
          await tx`
            INSERT INTO farm.integration_audit
              (farm_id, app_id, printer_assignment_id, actor_kind, actor_id, action, resource_type, resource_id, outcome, occurred_at, details)
            VALUES
              (${record.farmId}::uuid, ${record.appId}::uuid, ${record.printerAssignmentId}::uuid, 'app', ${record.appId}, 'printer.action', 'action', ${record.id}::uuid, ${record.status === 'held' ? 'held' : 'accepted'}, ${now}, ${tx.json({ actionName: record.action.action, status: record.status })})`
          return { kind: 'created', record }
        }
        const existing = await tx<(ActionRecord & { cmdId: string | null })[]>`
          SELECT ${actionColumns(tx as unknown as Sql)},
            (SELECT e.cmd_id::text FROM farm.integration_envelopes e WHERE e.kind = 'action' AND e.resource_id = a.id) AS "cmdId"
          FROM farm.integration_actions a
          WHERE a.app_id = ${action.appId}::uuid AND a.idempotency_key = ${action.idempotencyKey}`
        if (!existing[0]) return { kind: 'refused' }
        const { cmdId, ...record } = existing[0]
        return { kind: 'existing', record, cmdId }
      })
    } catch (cause) {
      const code = (cause as { code?: string }).code
      if (code === 'P0001' || code === '23514') return { kind: 'refused' }
      throw cause
    }
  }

  async get(id: string, appId: string) {
    if (!uuid.test(id) || !uuid.test(appId)) return null
    const rows = await this.sql<ActionRecord[]>`
      SELECT ${actionColumns(this.sql)} FROM farm.integration_actions a
      WHERE a.id = ${id}::uuid AND a.app_id = ${appId}::uuid`
    if (!rows[0]) return null
    const record = { ...rows[0] }
    const envelopes = await this.sql<EnvelopeRecord[]>`
      SELECT ${envelopeColumns(this.sql)} FROM farm.integration_envelopes e
      WHERE e.kind = 'action' AND e.resource_id = ${id}::uuid`
    const envelope = envelopes[0] ? { ...envelopes[0] } : null
    return { record, envelope }
  }
}
