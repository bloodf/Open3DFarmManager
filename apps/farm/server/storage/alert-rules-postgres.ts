import type { Sql, TransactionSql } from 'postgres'
import type { FarmAlertKind } from '../../app/utils/farm-alerts.ts'

function managedSettings(tx: TransactionSql, farmId: string, appId: string) {
  return {
    async writeRule(kind: FarmAlertKind, enabled: boolean) {
      await tx`
        INSERT INTO farm.integration_alert_rules (farm_id, kind, enabled)
        VALUES (${farmId}::uuid, ${kind}, ${enabled})
        ON CONFLICT (farm_id, kind) DO UPDATE SET enabled = excluded.enabled
      `
    },
    async writeChannel(sealed: string) {
      await tx`
        INSERT INTO farm.integration_notification_channels (farm_id, app_id, sealed_configuration)
        VALUES (${farmId}::uuid, ${appId}::uuid, ${sealed})
        ON CONFLICT (farm_id, app_id) DO UPDATE SET sealed_configuration = excluded.sealed_configuration
      `
    },
    async readChannel() {
      const [row] = await tx<{ sealed_configuration: string }[]>`
        SELECT sealed_configuration FROM farm.integration_notification_channels
        WHERE farm_id = ${farmId}::uuid AND app_id = ${appId}::uuid
      `
      return row?.sealed_configuration ?? null
    },
  }
}

export function alertRulesStore(sql: Sql) {
  return {
    async list(farmId: string) {
      return sql<{ kind: FarmAlertKind; enabled: boolean }[]>`
        SELECT kind, enabled FROM farm.integration_alert_rules
        WHERE farm_id = ${farmId}::uuid
      `
    },
    async disabled(farmIds: string[]) {
      return sql<{ farmId: string; kind: FarmAlertKind }[]>`
        SELECT farm_id AS "farmId", kind FROM farm.integration_alert_rules
        WHERE farm_id = ANY(${farmIds}::uuid[]) AND NOT enabled
      `
    },
    async manage<T>(
      appId: string,
      farmId: string,
      grantIds: string[],
      work: (settings: ReturnType<typeof managedSettings>) => Promise<T>,
    ) {
      return sql.begin(async (tx) => {
        // Serialize the settings operation with grant revocation and role changes.
        const [grant] = await tx`
          SELECT g.id FROM farm.integration_app_grants g
          JOIN farm.integration_apps app ON app.id = g.app_id
          JOIN farm.memberships m ON m.farm_id = g.farm_id AND m.account_id = g.created_by
          JOIN farm.session_accounts a ON a.id = m.account_id
          WHERE g.id = ANY(${grantIds}::uuid[])
            AND g.app_id = ${appId}::uuid AND g.farm_id = ${farmId}::uuid
            AND g.printer_assignment_id IS NULL AND g.disabled_at IS NULL
            AND 'alerts:manage' = ANY(g.scopes) AND NOT g.requires_approval
            AND app.revoked_at IS NULL AND m.role = 'owner'
            AND m.revoked_at IS NULL AND NOT a.disabled
          ORDER BY g.id LIMIT 1 FOR SHARE OF g, app, m, a
        `
        return grant
          ? { value: await work(managedSettings(tx, farmId, appId)) }
          : null
      })
    },
  }
}
