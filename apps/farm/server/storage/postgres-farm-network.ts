import type { Sql, TransactionSql } from 'postgres'
import type { TelemetryEvent } from '@open3dfarmmanager/farm-protocol'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionPolicy,
  type SessionRecord,
} from '../utils/auth/session-contract.ts'
import { inventoryUuid } from './postgres-connector-inventory.ts'
import type { FarmRole, NetworkRows } from '../utils/network-projection.ts'

export interface FarmNetworkInput {
  sessionRecordId: string
  policy: SessionPolicy
  farmId: string
}
export type FarmNetworkFailure = {
  ok: false
  reason: 'invalid-input' | 'unauthorized' | 'forbidden' | 'storage-unavailable'
}
export interface FarmNetworkReader {
  read(
    input: FarmNetworkInput,
  ): Promise<({ ok: true } & NetworkRows) | FarmNetworkFailure>
}

const MAX_HEALTH_BYTES = 32 * 1024

/**
 * The newest discovery report in a batch replaces the Connector's stored set;
 * an older report never overwrites a newer one. Internal write, not authorized here.
 */
export async function recordDiscoveries(
  tx: TransactionSql,
  scope: { farmId: string; agentId: string },
  events: readonly TelemetryEvent[],
): Promise<void> {
  const newest = events
    .filter((event) => event.kind === 'discovery')
    .sort((a, b) => b.queuedAt - a.queuedAt)[0]
  if (!newest) return
  await tx`INSERT INTO farm.connector_discoveries (farm_id, agent_id, observed_at, printers)
    VALUES (${scope.farmId}::uuid, ${scope.agentId}::uuid, ${newest.queuedAt}, ${tx.json(newest.discovery)}::jsonb)
    ON CONFLICT (farm_id, agent_id) DO UPDATE SET observed_at = EXCLUDED.observed_at, printers = EXCLUDED.printers
    WHERE farm.connector_discoveries.observed_at < EXCLUDED.observed_at`
}

/** Keeps only the latest heartbeat per Connector. The health document is size-bounded. */
export async function recordHeartbeat(
  tx: TransactionSql,
  scope: { farmId: string; agentId: string },
  observedAt: number,
  health: { connector: unknown; printers: readonly unknown[] },
): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(health)) > MAX_HEALTH_BYTES)
    throw new Error('Heartbeat health too large')
  await tx`INSERT INTO farm.connector_heartbeats (farm_id, agent_id, last_seen_at, health)
    VALUES (${scope.farmId}::uuid, ${scope.agentId}::uuid, ${observedAt}, ${tx.json(health as never)}::jsonb)
    ON CONFLICT (farm_id, agent_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, health = EXCLUDED.health
    WHERE farm.connector_heartbeats.last_seen_at < EXCLUDED.last_seen_at`
}

/**
 * Read-only network view. Session and membership checks mirror the printer
 * state reader; every query is scoped to the checked farm, so another farm's
 * Connectors, printers or discoveries are never read.
 */
export class PostgresFarmNetworkReader implements FarmNetworkReader {
  private inflight = 0
  private readonly sql: Sql
  private readonly clock: () => number

  constructor(sql: Sql, clock: () => number = Date.now) {
    this.sql = sql
    this.clock = clock
  }

  async read(
    input: FarmNetworkInput,
  ): Promise<({ ok: true } & NetworkRows) | FarmNetworkFailure> {
    if (
      !inventoryUuid.test(input.farmId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionRecordId) ||
      !Number.isSafeInteger(input.policy.idleTimeoutMs) ||
      input.policy.idleTimeoutMs <= 0
    )
      return { ok: false, reason: 'invalid-input' }
    if (this.inflight >= 32) return { ok: false, reason: 'storage-unavailable' }
    this.inflight++
    try {
      return await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const accounts = await tx<
          AccountSessionState[]
        >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${input.sessionRecordId}) FOR SHARE`
        const sessions = await tx<
          SessionRecord[]
        >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id = ${input.sessionRecordId} FOR UPDATE`
        const firstAt = this.clock()
        const first = evaluateSession(
          input.sessionRecordId,
          sessions[0] ?? null,
          accounts[0] ?? null,
          firstAt,
          input.policy,
        )
        if (!first.ok)
          return { ok: false as const, reason: 'unauthorized' as const }
        const members = await tx<
          { role: FarmRole; revoked_at: number | null }[]
        >`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${input.farmId}::uuid AND account_id = ${first.accountId} FOR SHARE`
        const member = members[0]
        if (!member || member.revoked_at !== null)
          return { ok: false as const, reason: 'forbidden' as const }
        const connectors = await tx<
          NetworkRows['connectors']
        >`SELECT e.agent_id AS "agentId", e.fingerprint, e.status, h.last_seen_at::float8 AS "lastSeenAt", h.health
          FROM farm.connector_enrollments e
          LEFT JOIN farm.connector_heartbeats h ON h.farm_id = e.farm_id AND h.agent_id = e.agent_id
          WHERE e.farm_id = ${input.farmId}::uuid
          ORDER BY e.agent_id LIMIT 200`
        const printers = await tx<
          NetworkRows['printers']
        >`SELECT id AS "assignmentId", agent_id AS "agentId", printer_key AS "printerKey", display_name AS "displayName"
          FROM farm.printer_assignments
          WHERE farm_id = ${input.farmId}::uuid AND revoked_at IS NULL
          ORDER BY id LIMIT 1000`
        const discoveries = await tx<
          NetworkRows['discoveries']
        >`SELECT agent_id AS "agentId", observed_at::float8 AS "observedAt", printers
          FROM farm.connector_discoveries
          WHERE farm_id = ${input.farmId}::uuid
          ORDER BY agent_id LIMIT 200`
        const now = this.clock()
        const current = evaluateSession(
          input.sessionRecordId,
          sessions[0] ?? null,
          accounts[0] ?? null,
          now,
          input.policy,
        )
        if (now < firstAt || !current.ok)
          return { ok: false as const, reason: 'unauthorized' as const }
        await tx`UPDATE farm.account_sessions SET last_seen_at=${current.touchAt} WHERE id=${input.sessionRecordId}`
        return {
          ok: true as const,
          role: member.role,
          connectors: [...connectors],
          printers: [...printers],
          discoveries: [...discoveries],
        }
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    } finally {
      this.inflight--
    }
  }
}
