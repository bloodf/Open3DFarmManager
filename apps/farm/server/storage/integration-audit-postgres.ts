import type { Sql } from 'postgres'
import type {
  IntegrationAuditEntry,
  IntegrationAuditFilter,
  IntegrationAuditStore,
} from '../services/integration-audit.ts'
export class PostgresIntegrationAudit implements IntegrationAuditStore {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }
  async append(
    input: Omit<IntegrationAuditEntry, 'id'>,
  ): Promise<IntegrationAuditEntry> {
    const rows = await this.sql<IntegrationAuditEntry[]>`
      INSERT INTO farm.integration_audit (farm_id, app_id, printer_assignment_id, actor_kind, actor_id, action, resource_type, resource_id, outcome, occurred_at, details)
      VALUES (${input.farmId}::uuid, ${input.appId}::uuid, ${input.printerAssignmentId}::uuid, ${input.actorKind}, ${input.actorId}, ${input.action}, ${input.resourceType}, ${input.resourceId}, ${input.outcome}, ${input.occurredAt}, ${this.sql.json(input.details)})
      RETURNING id::text, farm_id AS "farmId", app_id AS "appId", printer_assignment_id AS "printerAssignmentId", actor_kind AS "actorKind", actor_id AS "actorId", action, resource_type AS "resourceType", resource_id AS "resourceId", outcome, occurred_at::float8 AS "occurredAt", details`
    return rows[0]!
  }
  async listForOwner(
    actorId: string,
    filter: IntegrationAuditFilter,
  ): Promise<IntegrationAuditEntry[] | null> {
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 100))
    const rows = await this.sql<IntegrationAuditEntry[]>`
      SELECT e.id::text, e.farm_id AS "farmId", e.app_id AS "appId", e.printer_assignment_id AS "printerAssignmentId", e.actor_kind AS "actorKind", e.actor_id AS "actorId", e.action, e.resource_type AS "resourceType", e.resource_id AS "resourceId", e.outcome, e.occurred_at::float8 AS "occurredAt", e.details
      FROM farm.integration_audit e
      WHERE e.farm_id = ${filter.farmId}::uuid
        AND EXISTS (SELECT 1 FROM farm.memberships m WHERE m.farm_id=e.farm_id AND m.account_id=${actorId} AND m.role='owner' AND m.revoked_at IS NULL)
        AND (${filter.appId ?? null}::uuid IS NULL OR e.app_id=${filter.appId ?? null}::uuid)
        AND (${filter.printerAssignmentId ?? null}::uuid IS NULL OR e.printer_assignment_id=${filter.printerAssignmentId ?? null}::uuid)
        AND (${filter.beforeId ?? null}::bigint IS NULL OR e.id < ${filter.beforeId ?? null}::bigint)
      ORDER BY e.id DESC LIMIT ${limit}`
    // A valid empty result still needs distinguishable authorization.
    if (
      rows.length ||
      (await this
        .sql`SELECT 1 FROM farm.memberships WHERE farm_id=${filter.farmId}::uuid AND account_id=${actorId} AND role='owner' AND revoked_at IS NULL`)
    )
      return rows
    return null
  }
}
