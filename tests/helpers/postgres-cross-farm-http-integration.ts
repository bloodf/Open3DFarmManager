import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { PostgresConnectorInventory } from '../../apps/farm/server/storage/postgres-connector-inventory.ts'
import { PostgresConnectorRevocation } from '../../apps/farm/server/storage/postgres-connector-revocation.ts'
import { PostgresMembers } from '../../apps/farm/server/storage/postgres-members.ts'
import { PostgresPasswordReset } from '../../apps/farm/server/storage/postgres-password-reset.ts'
import { PostgresPrinterAssignmentInventory } from '../../apps/farm/server/storage/postgres-printer-assignment-inventory.ts'
import { PostgresPrinterOwnership } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'
import { PostgresPrinterStateReader } from '../../apps/farm/server/storage/postgres-printer-state-reader.ts'
import { PostgresJobHistory } from '../../apps/farm/server/storage/job-history-store.ts'
import { PostgresRegistration } from '../../apps/farm/server/storage/postgres-registration.ts'
import { PostgresSessionRepository } from '../../apps/farm/server/storage/postgres-session.ts'
import {
  assertCrossFarmDenied,
  FOREIGN_FINGERPRINT,
  serveRoutes,
  testCookieConfig,
  type Backend,
  type FarmIds,
  type Scenario,
} from './cross-farm-http.ts'

const origin = 'https://farm.example.invalid'
const HOUR = 3_600_000

/** One login per runtime store, each bound to the capability role it has in production. */
export const CROSS_FARM_ROLES = {
  inventory: 'farm_connector_inventory',
  ownership: 'farm_printer_ownership',
  revoker: 'farm_connector_revoker',
  jobHistory: 'farm_job_history_reader',
  printerStates: 'farm_printer_state_reader',
  registration: 'farm_account_registration',
  passwordReset: 'farm_password_reset',
  sessions: 'farm_session_runtime',
} as const
export type CrossFarmPools = Record<keyof typeof CROSS_FARM_ROLES, Sql>

/**
 * Disposable, fully migrated database only. Two farms, two owner accounts with
 * live sessions and one farm's worth of every row each route can touch; the
 * real stores answer behind the real routes.
 */
export async function testPostgresCrossFarmHttp(
  admin: Sql,
  pools: CrossFarmPools,
) {
  // Every timestamp derives from this single clock reading.
  const now = Date.now()
  const digest = (c: string) => c.repeat(64)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
  const sessions: [string, string] = [
    'session_zero_' + suffix,
    'session_one_' + suffix,
  ]
  const farms: FarmIds[] = []
  for (const index of [0, 1]) {
    const farm: FarmIds = {
      farmId: randomUUID(),
      agentId: randomUUID(),
      assignmentId: randomUUID(),
      printerKey: `printer-key-${index}-${suffix}`,
      inviteId: randomUUID(),
      memberId: `member_${index}_${suffix}`,
    }
    farms.push(farm)
    const owner = `owner_${index}_${suffix}`
    await admin`INSERT INTO farm.farms (id) VALUES (${farm.farmId}::uuid)`
    for (const account of [owner, farm.memberId]) {
      await admin`INSERT INTO farm.session_accounts (id) VALUES (${account})`
      await admin`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${account}, ${account.toLowerCase()}, ${'synthetic-cross-farm-hash-' + 'x'.repeat(24)})`
    }
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${sessions[index as 0 | 1]}, ${owner}, 0, ${now}, ${now}, ${now + 8 * HOUR})`
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm.farmId}::uuid, ${owner}, 'owner'), (${farm.farmId}::uuid, ${farm.memberId}, 'viewer')`
    await admin`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${farm.agentId}::uuid, ${farm.farmId}::uuid, ${'A'.repeat(59)}, ${FOREIGN_FINGERPRINT})`
    await admin`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${farm.agentId}::uuid`
    await admin`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by) VALUES (${farm.assignmentId}::uuid, ${farm.farmId}::uuid, ${farm.agentId}::uuid, ${farm.printerKey}, ${now}, ${owner})`
    await admin`INSERT INTO farm.account_invites (id, farm_id, role, digest, created_by, expires_at) VALUES (${farm.inviteId}::uuid, ${farm.farmId}::uuid, 'viewer', ${digest(index === 0 ? 'a' : 'b')}, ${owner}, ${new Date(now + 72 * HOUR)})`
    await admin`INSERT INTO farm.job_history (farm_id, agent_id, printer_key, outcome, filename, print_duration_seconds, total_duration_seconds, ended_at) VALUES (${farm.farmId}::uuid, ${farm.agentId}::uuid, ${farm.printerKey}, 'completed', 'part.gcode', 60, 70, ${now})`
    await admin`INSERT INTO farm.printer_latest_state (farm_id, agent_id, printer_key, observed_at, state) VALUES (${farm.farmId}::uuid, ${farm.agentId}::uuid, ${farm.printerKey}, ${now}, ${admin.json({ printerKey: farm.printerKey, state: 'idle', progress: 0, observedAt: now })})`
  }
  const registration = new PostgresRegistration(pools.registration)
  const auth = {
    origin,
    cookie: testCookieConfig(
      'independent-synthetic-cross-farm-secret-123456789',
    ),
    idleTimeoutMs: HOUR,
    lifetimeMs: 8 * HOUR,
    sessions: new PostgresSessionRepository(pools.sessions),
    credentials: {
      async consumeLimit() {
        return true
      },
      async find() {
        return null
      },
      async issue() {
        return null
      },
    },
    registration,
    members: new PostgresMembers(pools.registration),
  } satisfies Backend['auth']
  const backend: Backend = {
    auth,
    connectorInventory: new PostgresConnectorInventory(pools.inventory),
    printers: {
      ownership: new PostgresPrinterOwnership(pools.ownership),
      inventory: new PostgresPrinterAssignmentInventory(pools.ownership),
    },
    revocation: new PostgresConnectorRevocation(pools.revoker),
    jobHistory: new PostgresJobHistory(pools.jobHistory),
    printerStates: new PostgresPrinterStateReader(pools.printerStates),
    resetLinks: new PostgresPasswordReset(pools.passwordReset),
  }
  const scenario: Scenario = {
    backend,
    sessions,
    farms: [farms[0]!, farms[1]!],
    unknown: {
      farmId: randomUUID(),
      agentId: randomUUID(),
      assignmentId: randomUUID(),
      printerKey: 'printer-key-unknown-' + suffix,
      inviteId: randomUUID(),
      memberId: 'member_unknown_' + suffix,
    },
    async snapshot() {
      // Session touches are expected; every farm-scoped row is not allowed to move.
      return {
        memberships:
          await admin`SELECT farm_id, account_id, role, revoked_at FROM farm.memberships ORDER BY farm_id, account_id`,
        enrollments:
          await admin`SELECT agent_id, farm_id, status FROM farm.connector_enrollments ORDER BY agent_id`,
        assignments:
          await admin`SELECT id, farm_id, printer_key, revoked_at FROM farm.printer_assignments ORDER BY id`,
        invites:
          await admin`SELECT id, farm_id, role, revoked_at, consumed_at FROM farm.account_invites ORDER BY id`,
        resets:
          await admin`SELECT count(*)::int AS n FROM farm.password_reset_tokens`,
      }
    },
  }
  const server = await serveRoutes(backend)
  try {
    return (await assertCrossFarmDenied(scenario, server)).checks
  } finally {
    await server.close()
  }
}
