import type { Sql } from 'postgres'
import type {
  EnvelopeRecord,
  EnvelopeResult,
  EnvelopeStatus,
  InsertOutcome,
  IntegrationDeliveryStore,
  NewEnvelope,
} from '../services/integration-delivery.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0

const columns = (sql: Sql) =>
  sql`e.cmd_id::text AS "cmdId", e.app_id::text AS "appId", e.grant_id::text AS "grantId", e.farm_id::text AS "farmId", e.agent_id::text AS "agentId", e.printer_assignment_id::text AS "printerAssignmentId", e.kind, e.resource_id::text AS "resourceId", e.required_scope AS "requiredScope", e.nonce, e.wire, e.issued_at::float8 AS "issuedAt", e.expires_at::float8 AS "expiresAt", e.status, e.refusal_code AS "refusalCode", e.result_detail AS "resultDetail", e.result_message AS "resultMessage", e.history_entry_id AS "historyEntryId", e.created_at::float8 AS "createdAt", e.updated_at::float8 AS "updatedAt"`
// The same columns unqualified, for RETURNING clauses.
const returning = (sql: Sql) =>
  sql`cmd_id::text AS "cmdId", app_id::text AS "appId", grant_id::text AS "grantId", farm_id::text AS "farmId", agent_id::text AS "agentId", printer_assignment_id::text AS "printerAssignmentId", kind, resource_id::text AS "resourceId", required_scope AS "requiredScope", nonce, wire, issued_at::float8 AS "issuedAt", expires_at::float8 AS "expiresAt", status, refusal_code AS "refusalCode", result_detail AS "resultDetail", result_message AS "resultMessage", history_entry_id AS "historyEntryId", created_at::float8 AS "createdAt", updated_at::float8 AS "updatedAt"`

/** True while the envelope's app, grant and assignment still allow delivery. */
const authorityActive = (sql: Sql) => sql`
  EXISTS (
    SELECT 1 FROM farm.integration_app_grants g
    JOIN farm.integration_apps a ON a.id = g.app_id
    JOIN farm.printer_assignments p ON p.id = e.printer_assignment_id
  JOIN farm.farms f ON f.id = e.farm_id
    WHERE g.id = e.grant_id AND g.app_id = e.app_id AND g.farm_id = e.farm_id
    AND (g.printer_assignment_id IS NULL OR g.printer_assignment_id = p.id)
    AND e.required_scope = ANY(g.scopes)
    AND (NOT a.sandbox OR f.sandbox)
    AND g.disabled_at IS NULL AND a.revoked_at IS NULL
      AND p.revoked_at IS NULL AND p.farm_id = e.farm_id AND p.agent_id = e.agent_id)`

/** The farm_integration_delivery role is the least-privilege caller. */
export class PostgresIntegrationDelivery implements IntegrationDeliveryStore {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }
  async insert(envelope: NewEnvelope, now: number): Promise<InsertOutcome> {
    if (!validTime(now)) throw new Error('Invalid time')
    const sql = this.sql
    try {
      return await sql.begin(async (tx): Promise<InsertOutcome> => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const rows = await tx<EnvelopeRecord[]>`
          INSERT INTO farm.integration_envelopes (cmd_id, app_id, grant_id, farm_id, agent_id, printer_assignment_id, kind, resource_id, required_scope, nonce, wire, issued_at, expires_at, created_at, updated_at)
          VALUES (${envelope.cmdId}::uuid, ${envelope.appId}::uuid, ${envelope.grantId}::uuid, ${envelope.farmId}::uuid, ${envelope.agentId}::uuid, ${envelope.printerAssignmentId}::uuid, ${envelope.kind}, ${envelope.resourceId}::uuid, ${envelope.requiredScope}, ${envelope.nonce}, ${envelope.wire}, ${envelope.issuedAt}, ${envelope.expiresAt}, ${now}, ${now})
          ON CONFLICT (kind, resource_id) DO NOTHING
          RETURNING ${returning(tx as unknown as Sql)}`
        if (rows[0]) return { kind: 'created', record: rows[0] }
        const existing = await tx<EnvelopeRecord[]>`
          SELECT ${columns(tx as unknown as Sql)} FROM farm.integration_envelopes e
          WHERE e.kind = ${envelope.kind} AND e.resource_id = ${envelope.resourceId}::uuid`
        return existing[0]
          ? { kind: 'existing', record: existing[0] }
          : { kind: 'refused' }
      })
    } catch (cause) {
      // A guard trigger or constraint refused it: grant, scope, assignment, sandbox or bounds.
      const code = (cause as { code?: string }).code
      if (code === 'P0001' || code === '23514') return { kind: 'refused' }
      throw cause
    }
  }
  async get(cmdId: string): Promise<EnvelopeRecord | null> {
    if (!uuid.test(cmdId)) return null
    const rows = await this.sql<EnvelopeRecord[]>`
      SELECT ${columns(this.sql)} FROM farm.integration_envelopes e WHERE e.cmd_id = ${cmdId}::uuid`
    return rows[0] ?? null
  }
  async listPending(
    farmId: string,
    agentId: string,
    now: number,
    limit: number,
  ): Promise<EnvelopeRecord[]> {
    if (!uuid.test(farmId) || !uuid.test(agentId) || !validTime(now)) return []
    const bound = Math.max(1, Math.min(Math.trunc(limit), 100))
    return await this.sql<EnvelopeRecord[]>`
      SELECT ${columns(this.sql)} FROM farm.integration_envelopes e
      WHERE e.farm_id = ${farmId}::uuid AND e.agent_id = ${agentId}::uuid
        AND e.status = 'pending' AND e.expires_at > ${now}
      ORDER BY e.created_at, e.cmd_id LIMIT ${bound}`
  }
  async claim(cmdId: string, now: number): Promise<EnvelopeRecord | null> {
    if (!uuid.test(cmdId) || !validTime(now)) return null
    const rows = await this.sql<EnvelopeRecord[]>`
      UPDATE farm.integration_envelopes e
      SET status = 'sending', updated_at = GREATEST(${now}, e.updated_at)
      WHERE e.cmd_id = ${cmdId}::uuid AND e.status = 'pending' AND e.expires_at > ${now}
        AND ${authorityActive(this.sql)}
      RETURNING ${returning(this.sql)}`
    return rows[0] ?? null
  }
  async settleUnclaimable(
    cmdId: string,
    now: number,
  ): Promise<EnvelopeRecord | null> {
    if (!uuid.test(cmdId) || !validTime(now)) return null
    const rows = await this.sql<EnvelopeRecord[]>`
      UPDATE farm.integration_envelopes e
      SET status = CASE WHEN e.expires_at <= ${now} THEN 'expired' ELSE 'rejected' END,
          updated_at = GREATEST(${now}, e.updated_at)
      WHERE e.cmd_id = ${cmdId}::uuid AND e.status = 'pending'
        AND (e.expires_at <= ${now} OR NOT ${authorityActive(this.sql)})
      RETURNING ${returning(this.sql)}`
    return rows[0] ?? null
  }
  async transition(
    cmdId: string,
    from: readonly EnvelopeStatus[],
    to: EnvelopeStatus,
    now: number,
    result: EnvelopeResult = {},
  ): Promise<EnvelopeRecord | null> {
    if (!uuid.test(cmdId) || !validTime(now)) return null
    try {
      const rows = await this.sql<EnvelopeRecord[]>`
        UPDATE farm.integration_envelopes e
        SET status = ${to}, updated_at = GREATEST(${now}, e.updated_at),
            refusal_code = COALESCE(${result.refusalCode ?? null}, e.refusal_code),
            result_detail = COALESCE(${result.detail ?? null}, e.result_detail),
            result_message = COALESCE(${result.message ?? null}, e.result_message),
            history_entry_id = COALESCE(${result.historyEntryId ?? null}, e.history_entry_id)
        WHERE e.cmd_id = ${cmdId}::uuid AND e.status = ANY (${[...from]}::text[])
        RETURNING ${returning(this.sql)}`
      return rows[0] ?? null
    } catch (cause) {
      // The guard refused a status change that lost a race with another one.
      if ((cause as { code?: string }).code === 'P0001') return null
      throw cause
    }
  }
  async sweep(now: number, limit: number): Promise<EnvelopeRecord[]> {
    if (!validTime(now)) return []
    const bound = Math.max(1, Math.min(Math.trunc(limit), 500))
    return await this.sql<EnvelopeRecord[]>`
      UPDATE farm.integration_envelopes e
      SET status = CASE WHEN e.status = 'pending' THEN 'expired' ELSE 'outcome-unknown' END,
          updated_at = GREATEST(${now}, e.updated_at)
      WHERE e.cmd_id IN (
        SELECT d.cmd_id FROM farm.integration_envelopes d
        WHERE d.status IN ('pending', 'sending', 'sent') AND d.expires_at <= ${now}
        ORDER BY d.expires_at LIMIT ${bound} FOR UPDATE SKIP LOCKED)
      RETURNING ${returning(this.sql)}`
  }
}
