import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import type {
  IntegrationApp,
  IntegrationAppsStore,
  IntegrationCredential,
  IntegrationGrant,
  NewGrant,
  StoreFailure,
  StoredCredential,
} from '../services/integration-apps.ts'
import type { IntegrationPrinterRow } from '../utils/integration-auth.ts'
import { validScopes } from '../services/integration-apps.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const clientIdPattern = /^[A-Za-z0-9_-]{16,64}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0

// Fixed aliases: apps are `a`, grants are `g`.
const appColumns = (tx: Sql | TransactionSql) =>
  tx`a.id, a.farm_id AS "farmId", a.name, a.sandbox, a.created_at::float8 AS "createdAt", a.revoked_at::float8 AS "revokedAt"`
const grantColumns = (tx: Sql | TransactionSql) =>
  tx`g.id, g.app_id AS "appId", g.farm_id AS "farmId", g.printer_assignment_id AS "printerAssignmentId", g.scopes, g.requires_approval AS "requiresApproval", g.created_at::float8 AS "createdAt", g.disabled_at::float8 AS "disabledAt", g.disabled_reason AS "disabledReason"`

/** Rows are one bounded transaction each; the farm_integration_apps role is the least-privilege caller. */
export class PostgresIntegrationApps implements IntegrationAppsStore {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }
  private async run<T>(
    operation: (tx: TransactionSql) => Promise<T>,
  ): Promise<T | 'conflict'> {
    try {
      return (await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        return await operation(tx)
      })) as T
    } catch (cause) {
      const code = (cause as { code?: string }).code
      // unique_violation, or a guard trigger that lost a race with a concurrent change.
      if (code === '23505' || code === 'P0001') return 'conflict'
      throw cause
    }
  }
  /** Active owner of the farm; the membership and account rows stay locked until commit. */
  private async manages(
    tx: TransactionSql,
    actorId: string,
    farmId: string,
  ): Promise<boolean> {
    if (!uuid.test(farmId) || typeof actorId !== 'string') return false
    const rows =
      await tx`SELECT 1 FROM farm.memberships m JOIN farm.session_accounts a ON a.id = m.account_id WHERE m.farm_id = ${farmId}::uuid AND m.account_id = ${actorId} AND m.role = 'owner' AND m.revoked_at IS NULL AND NOT a.disabled FOR SHARE OF m, a`
    return rows.length > 0
  }
  private async activeApp(
    tx: TransactionSql,
    actorId: string,
    appId: string,
  ): Promise<IntegrationApp | null> {
    if (!uuid.test(appId)) return null
    const rows = await tx<
      IntegrationApp[]
    >`SELECT ${appColumns(tx)} FROM farm.integration_apps a WHERE a.id = ${appId}::uuid AND a.revoked_at IS NULL`
    const app = rows[0]
    return app && (await this.manages(tx, actorId, app.farmId))
      ? { ...app }
      : null
  }

  async createApp(
    actorId: string,
    input: { farmId: string; name: string; sandbox: boolean },
    now: number,
  ): Promise<IntegrationApp | StoreFailure> {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (
      !validTime(now) ||
      name.length < 1 ||
      name.length > 128 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(name) ||
      typeof input.sandbox !== 'boolean'
    )
      return 'invalid-input'
    return await this.run<IntegrationApp | StoreFailure>(async (tx) => {
      if (!(await this.manages(tx, actorId, input.farmId))) return 'not-found'
      const farm =
        await tx`SELECT sandbox FROM farm.farms WHERE id = ${input.farmId}::uuid`
      if (input.sandbox && farm[0]?.sandbox !== true) return 'sandbox-violation'
      const rows = await tx<
        IntegrationApp[]
      >`INSERT INTO farm.integration_apps AS a (id, farm_id, name, sandbox, created_at, created_by) VALUES (${randomUUID()}::uuid, ${input.farmId}::uuid, ${name}, ${input.sandbox}, ${now}, ${actorId}) RETURNING ${appColumns(tx)}`
      return { ...rows[0]! }
    })
  }

  async revokeApp(
    actorId: string,
    appId: string,
    now: number,
  ): Promise<'ok' | StoreFailure> {
    if (!validTime(now)) return 'invalid-input'
    return await this.run<'ok' | StoreFailure>(async (tx) => {
      const app = await this.activeApp(tx, actorId, appId)
      if (!app || now < app.createdAt)
        return app ? 'invalid-input' : 'not-found'
      await tx`UPDATE farm.integration_apps SET revoked_at = ${now} WHERE id = ${appId}::uuid AND revoked_at IS NULL`
      return 'ok'
    })
  }

  async addCredential(
    actorId: string,
    appId: string,
    input: { clientId: string; secretHash: string },
    now: number,
  ): Promise<IntegrationCredential | StoreFailure> {
    if (
      !validTime(now) ||
      !clientIdPattern.test(input.clientId) ||
      !digestPattern.test(input.secretHash)
    )
      return 'invalid-input'
    return await this.run<IntegrationCredential | StoreFailure>(async (tx) => {
      if (!(await this.activeApp(tx, actorId, appId))) return 'not-found'
      const rows = await tx<
        IntegrationCredential[]
      >`INSERT INTO farm.integration_app_credentials (id, app_id, client_id, secret_hash, created_at) VALUES (${randomUUID()}::uuid, ${appId}::uuid, ${input.clientId}, ${input.secretHash}, ${now}) RETURNING id, app_id AS "appId", client_id AS "clientId", created_at::float8 AS "createdAt", revoked_at::float8 AS "revokedAt"`
      return { ...rows[0]! }
    })
  }

  async revokeCredential(
    actorId: string,
    credentialId: string,
    now: number,
    expectedFarmId?: string,
  ): Promise<'ok' | StoreFailure> {
    if (!validTime(now) || !uuid.test(credentialId)) return 'invalid-input'
    return await this.run<'ok' | StoreFailure>(async (tx) => {
      const rows =
        await tx`SELECT c.app_id, c.created_at::float8 AS created FROM farm.integration_app_credentials c WHERE c.id = ${credentialId}::uuid AND c.revoked_at IS NULL`
      const row = rows[0]
      if (!row) return 'not-found'
      const farm =
        await tx`SELECT farm_id FROM farm.integration_apps WHERE id = ${row.app_id as string}::uuid`
      if (expectedFarmId !== undefined && farm[0]?.farm_id !== expectedFarmId)
        return 'not-found'
      if (!(await this.manages(tx, actorId, farm[0]?.farm_id as string)))
        return 'not-found'
      if (now < (row.created as number)) return 'invalid-input'
      await tx`UPDATE farm.integration_app_credentials SET revoked_at = ${now} WHERE id = ${credentialId}::uuid AND revoked_at IS NULL`
      return 'ok'
    })
  }

  async createGrant(
    actorId: string,
    input: NewGrant,
    now: number,
  ): Promise<IntegrationGrant | StoreFailure> {
    if (
      !validTime(now) ||
      !uuid.test(input.farmId) ||
      !validScopes(input.scopes) ||
      (input.printerAssignmentId !== undefined &&
        !uuid.test(input.printerAssignmentId)) ||
      (input.requiresApproval !== undefined &&
        typeof input.requiresApproval !== 'boolean')
    )
      return 'invalid-input'
    return await this.run<IntegrationGrant | StoreFailure>(async (tx) => {
      // The actor must manage the app's farm and the farm the grant exposes.
      const app = await this.activeApp(tx, actorId, input.appId)
      if (!app || !(await this.manages(tx, actorId, input.farmId)))
        return 'not-found'
      const farm =
        await tx`SELECT sandbox FROM farm.farms WHERE id = ${input.farmId}::uuid`
      if (app.sandbox && farm[0]?.sandbox !== true) return 'sandbox-violation'
      if (input.printerAssignmentId) {
        const assignment =
          await tx`SELECT 1 FROM farm.printer_assignments WHERE id = ${input.printerAssignmentId}::uuid AND farm_id = ${input.farmId}::uuid AND revoked_at IS NULL`
        if (!assignment.length) return 'printer-unavailable'
      }
      const rows = await tx<
        IntegrationGrant[]
      >`INSERT INTO farm.integration_app_grants AS g (id, app_id, farm_id, printer_assignment_id, scopes, requires_approval, created_at, created_by) VALUES (${randomUUID()}::uuid, ${input.appId}::uuid, ${input.farmId}::uuid, ${input.printerAssignmentId ?? null}, ${input.scopes}::text[], ${input.requiresApproval ?? false}, ${now}, ${actorId}) RETURNING ${grantColumns(tx)}`
      return { ...rows[0]! }
    })
  }

  async revokeGrant(
    actorId: string,
    grantId: string,
    now: number,
  ): Promise<'ok' | StoreFailure> {
    if (!validTime(now) || !uuid.test(grantId)) return 'invalid-input'
    return await this.run<'ok' | StoreFailure>(async (tx) => {
      const rows =
        await tx`SELECT farm_id, created_at::float8 AS created FROM farm.integration_app_grants WHERE id = ${grantId}::uuid AND disabled_at IS NULL FOR UPDATE`
      const row = rows[0]
      if (!row || !(await this.manages(tx, actorId, row.farm_id as string)))
        return 'not-found'
      if (now < (row.created as number)) return 'invalid-input'
      await tx`UPDATE farm.integration_app_grants SET disabled_at = ${now}, disabled_reason = 'revoked' WHERE id = ${grantId}::uuid AND disabled_at IS NULL`
      return 'ok'
    })
  }

  async listApps(
    actorId: string,
    farmId: string,
  ): Promise<IntegrationApp[] | null> {
    const result = await this.run<IntegrationApp[] | null>(async (tx) => {
      if (!(await this.manages(tx, actorId, farmId))) return null
      return (
        await tx<
          IntegrationApp[]
        >`SELECT ${appColumns(tx)} FROM farm.integration_apps a WHERE a.farm_id = ${farmId}::uuid ORDER BY a.created_at, a.id`
      ).map((row) => ({ ...row }))
    })
    return result === 'conflict' ? null : result
  }

  async listGrants(
    actorId: string,
    appId: string,
  ): Promise<IntegrationGrant[] | null> {
    const result = await this.run<IntegrationGrant[] | null>(async (tx) => {
      if (!uuid.test(appId)) return null
      const apps =
        await tx`SELECT farm_id FROM farm.integration_apps WHERE id = ${appId}::uuid`
      if (
        !apps[0] ||
        !(await this.manages(tx, actorId, apps[0].farm_id as string))
      )
        return null
      return (
        await tx<
          IntegrationGrant[]
        >`SELECT ${grantColumns(tx)} FROM farm.integration_app_grants g WHERE g.app_id = ${appId}::uuid ORDER BY g.created_at, g.id`
      ).map((row) => ({ ...row }))
    })
    return result === 'conflict' ? null : result
  }

  async findActiveCredential(
    clientId: string,
  ): Promise<StoredCredential | null> {
    if (!clientIdPattern.test(clientId)) return null
    const rows = await this.sql<
      StoredCredential[]
    >`SELECT c.id, c.app_id AS "appId", c.client_id AS "clientId", c.secret_hash AS "secretHash", c.created_at::float8 AS "createdAt", c.revoked_at::float8 AS "revokedAt" FROM farm.integration_app_credentials c JOIN farm.integration_apps a ON a.id = c.app_id WHERE c.client_id = ${clientId} AND c.revoked_at IS NULL AND a.revoked_at IS NULL`
    return rows[0] ? { ...rows[0] } : null
  }

  async activePrinterFarm(printerId: string): Promise<string | null> {
    if (!uuid.test(printerId)) return null
    const rows = await this.sql<{ farmId: string }[]>`
      SELECT farm_id AS "farmId" FROM farm.printer_assignments
      WHERE id = ${printerId}::uuid AND revoked_at IS NULL
    `
    return rows[0]?.farmId ?? null
  }

  async readPrinters(input: {
    farmIds: string[]
    farmWideFarmIds: string[]
    assignmentIds: string[]
    farmId?: string
    afterId?: string
    snapshotAt: number
    limit: number
  }): Promise<IntegrationPrinterRow[]> {
    if (!input.farmIds.length) return []
    const rows = await this.sql<IntegrationPrinterRow[]>`
      SELECT a.id, a.farm_id AS "farmId", a.printer_key AS "printerKey",
        f.sandbox, s.state, s.observed_at::float8 AS "observedAt"
      FROM farm.printer_assignments a
      JOIN farm.farms f ON f.id = a.farm_id
      LEFT JOIN farm.printer_latest_state s
        ON s.farm_id = a.farm_id AND s.agent_id = a.agent_id
        AND s.printer_key = a.printer_key
      WHERE a.revoked_at IS NULL
        AND a.farm_id = ANY(${input.farmIds}::uuid[])
        AND (a.farm_id = ANY(${input.farmWideFarmIds}::uuid[])
          OR a.id = ANY(${input.assignmentIds}::uuid[]))
        AND (${input.farmId ?? null}::uuid IS NULL OR a.farm_id = ${input.farmId ?? null}::uuid)
        AND a.created_at <= ${input.snapshotAt}
        AND (${input.afterId ?? null}::uuid IS NULL OR a.id > ${input.afterId ?? null}::uuid)
      ORDER BY a.id LIMIT ${input.limit}
    `
    return rows.map((row) => ({ ...row }))
  }

  async readPrinter(printerId: string): Promise<IntegrationPrinterRow | null> {
    if (!uuid.test(printerId)) return null
    const rows = await this.sql<IntegrationPrinterRow[]>`
      SELECT a.id, a.farm_id AS "farmId", a.agent_id AS "agentId", a.printer_key AS "printerKey",
        f.sandbox, s.state, s.observed_at::float8 AS "observedAt"
      FROM farm.printer_assignments a
      JOIN farm.farms f ON f.id = a.farm_id
      LEFT JOIN farm.printer_latest_state s
        ON s.farm_id = a.farm_id AND s.agent_id = a.agent_id
        AND s.printer_key = a.printer_key
      WHERE a.id = ${printerId}::uuid AND a.revoked_at IS NULL
    `
    return rows[0] ? { ...rows[0] } : null
  }

  async effectiveGrants(appId: string): Promise<IntegrationGrant[]> {
    if (!uuid.test(appId)) return []
    const rows = await this.sql<
      IntegrationGrant[]
    >`SELECT ${grantColumns(this.sql)} FROM farm.integration_app_grants g JOIN farm.integration_apps a ON a.id = g.app_id LEFT JOIN farm.printer_assignments p ON p.id = g.printer_assignment_id WHERE g.app_id = ${appId}::uuid AND g.disabled_at IS NULL AND a.revoked_at IS NULL AND (g.printer_assignment_id IS NULL OR p.revoked_at IS NULL) ORDER BY g.created_at, g.id`
    return rows.map((row) => ({ ...row }))
  }
}
