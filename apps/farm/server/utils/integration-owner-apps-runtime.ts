import { getRouterParam, type RequestEvent } from 'nuxt/server'
import { authenticatedSession } from '../services/authenticated-session.ts'
import { IntegrationAppsService } from '../services/integration-apps.ts'
import { PostgresIntegrationApps } from '../storage/integration-apps-postgres.ts'
import { IntegrationAuditService } from '../services/integration-audit.ts'
import { PostgresIntegrationAudit } from '../storage/integration-audit-postgres.ts'
import { authRuntime } from './auth/runtime.ts'
import { integrationAuthPool } from './integration-auth-runtime.ts'
import type { OwnerAppsDeps } from '../services/integration-owner-apps-http.ts'

export async function ownerAppsRuntime(event: RequestEvent) {
  const { accountId } = await authenticatedSession(event, authRuntime())
  const sql = integrationAuthPool()
  const store = new PostgresIntegrationApps(sql)
  const deps: OwnerAppsDeps = {
    apps: new IntegrationAppsService(store),
    audit: new IntegrationAuditService(new PostgresIntegrationAudit(sql)),
    async isOwner(actorId, farmId) {
      const rows =
        await sql`SELECT 1 FROM farm.memberships WHERE account_id = ${actorId} AND farm_id = ${farmId}::uuid AND role = 'owner' AND revoked_at IS NULL`
      return rows.length > 0
    },
    async listPrinters(actorId, farmId) {
      const rows = await sql<{ assignmentId: string; printerKey: string }[]>`
        SELECT p.id AS "assignmentId", p.printer_key AS "printerKey"
        FROM farm.printer_assignments p
        JOIN farm.memberships m ON m.farm_id = p.farm_id
        WHERE m.account_id = ${actorId} AND m.role = 'owner' AND m.revoked_at IS NULL
          AND p.farm_id = ${farmId}::uuid AND p.revoked_at IS NULL
        ORDER BY p.printer_key, p.id`
      return rows.map((row) => ({ ...row }))
    },
  }
  return {
    actorId: accountId,
    farmId: getRouterParam(event, 'farmId') ?? '',
    appId: getRouterParam(event, 'appId') ?? '',
    grantId: getRouterParam(event, 'grantId') ?? '',
    credentialId: getRouterParam(event, 'credentialId') ?? '',
    deps,
    close: async () => {},
  }
}
