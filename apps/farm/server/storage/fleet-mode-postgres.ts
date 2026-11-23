import type { Sql, TransactionSql } from 'postgres'
import type {
  FleetModeRecord,
  FleetModeStore,
} from '../utils/integration-fleet-mode.ts'

export class PostgresFleetMode implements FleetModeStore {
  private readonly sql: Sql | TransactionSql

  constructor(sql: Sql | TransactionSql) {
    this.sql = sql
  }

  async read(printerId: string) {
    const [row] = await this.sql<FleetModeRecord[]>`
      SELECT mode, version, previous_mode AS "previousMode", app_id AS "appId"
      FROM farm.integration_fleet_mode WHERE printer_id = ${printerId}::uuid
    `
    return row ?? null
  }

  async compareAndSet({
    printerId,
    grantId,
    expectedVersion,
    next,
  }: Parameters<FleetModeStore['compareAndSet']>[0]) {
    const sql = this.sql
    const allowed = sql`
      SELECT p.id FROM farm.printer_assignments p
      JOIN farm.integration_app_grants g ON g.farm_id = p.farm_id
      JOIN farm.integration_apps a ON a.id = g.app_id
      WHERE p.id = ${printerId}::uuid AND p.revoked_at IS NULL
        AND g.id = ${grantId}::uuid AND g.app_id = ${next.appId}::uuid
        AND g.disabled_at IS NULL AND a.revoked_at IS NULL AND NOT g.requires_approval
        AND 'control:extended' = ANY(g.scopes)
        AND (g.printer_assignment_id IS NULL OR g.printer_assignment_id = p.id)
    `
    const updated =
      expectedVersion === null
        ? await sql`
          INSERT INTO farm.integration_fleet_mode (printer_id, mode, version, previous_mode, app_id)
          SELECT id, ${next.mode}, ${next.version}::uuid, ${next.previousMode}, ${next.appId}::uuid
          FROM (${allowed}) AS target
          ON CONFLICT (printer_id) DO NOTHING
        `
        : await sql`
          UPDATE farm.integration_fleet_mode AS current
          SET mode = ${next.mode}, version = ${next.version}::uuid,
            previous_mode = ${next.previousMode}, app_id = ${next.appId}::uuid
          FROM (${allowed}) AS target
          WHERE current.printer_id = target.id AND current.version = ${expectedVersion}::uuid
        `
    return updated.count === 1
  }
}

/** Read only a current assignment visible to a current farm member. */
export async function readMemberFleetMode(
  sql: Sql | TransactionSql,
  farmId: string,
  printerId: string,
  accountId: string,
) {
  const [row] = await sql<{ mode: 'in-service' | 'maintenance' }[]>`
    SELECT COALESCE(fm.mode, 'in-service') AS mode
    FROM farm.printer_assignments p
    JOIN farm.memberships m ON m.farm_id = p.farm_id
      AND m.account_id = ${accountId} AND m.revoked_at IS NULL
    LEFT JOIN farm.integration_fleet_mode fm ON fm.printer_id = p.id
    WHERE p.id = ${printerId}::uuid AND p.farm_id = ${farmId}::uuid
      AND p.revoked_at IS NULL
  `
  return row ?? null
}
