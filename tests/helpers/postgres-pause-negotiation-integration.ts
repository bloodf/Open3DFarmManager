import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import {
  PostgresPauseNegotiation,
  type PauseNegotiationConfig,
  type PauseNegotiationScope,
} from '../../apps/farm/server/storage/postgres-pause-negotiation.ts'

/** Caller owns freshly provisioned synthetic rows and restricted pools. */
export async function testPauseNegotiationRows(input: {
  admin: Sql
  runtime: Sql
  applicationName: string
  config: PauseNegotiationConfig
  scope: PauseNegotiationScope
  accountId: string
  printerKey: string
}): Promise<string[]> {
  const { admin, runtime, scope } = input
  const reader = new PostgresPauseNegotiation(runtime, input.config)
  const initial = await reader.read(scope)
  assert.ok(initial, 'Restricted role must read current negotiation authority')
  assert.equal(initial.authority.account_id, input.accountId)
  assert.equal(initial.authority.assignment_id, scope.assignmentId)
  assert.equal(initial.authority.role, 'owner')
  assert.equal(initial.printerKey, input.printerKey)
  assert.ok(initial.budget.monotonicDeadline > performance.now())
  assert.equal(
    await reader.read({ ...scope, assignmentId: randomUUID() }),
    null,
  )
  assert.equal(await reader.read({ ...scope, farmId: randomUUID() }), null)
  const baseline =
    await admin`SELECT last_seen_at FROM farm.account_sessions WHERE id=${scope.sessionRecordId}`

  async function waitForReaderLock(): Promise<void> {
    const deadline = performance.now() + 750
    for (;;) {
      const rows =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${input.applicationName} AND wait_event_type='Lock'`
      if (rows[0]?.n > 0) return
      assert.ok(performance.now() < deadline, 'Expected reader row-lock wait')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  // The UPDATE remains uncommitted until the reader demonstrably waits.
  const holder = await admin.reserve()
  let pending: ReturnType<typeof reader.read> | undefined
  try {
    await holder`BEGIN`
    await holder`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${scope.farmId}::uuid AND account_id=${input.accountId}`
    pending = reader.read(scope)
    await waitForReaderLock()
    await holder`COMMIT`
    assert.equal(
      await pending,
      null,
      'Committed downgrade must deny after wait',
    )
  } finally {
    try {
      await holder`ROLLBACK`
    } finally {
      holder.release()
      if (pending) await pending
      await admin`UPDATE farm.memberships SET role='owner' WHERE farm_id=${scope.farmId}::uuid AND account_id=${input.accountId}`
    }
  }
  assert.ok(await reader.read(scope))
  assert.deepEqual(
    await admin`SELECT last_seen_at FROM farm.account_sessions WHERE id=${scope.sessionRecordId}`,
    baseline,
    'Negotiation must not refresh idle activity',
  )

  // A separate short-lived session preserves the caller's main session.
  const expiredSession = 'pause_negotiation_' + randomUUID()
  await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) SELECT ${expiredSession},account_id,account_version,floor(extract(epoch FROM clock_timestamp())*1000)::bigint,floor(extract(epoch FROM clock_timestamp())*1000)::bigint,floor(extract(epoch FROM clock_timestamp())*1000)::bigint+600 FROM farm.account_sessions WHERE id=${scope.sessionRecordId}`
  const expiryHolder = await admin.reserve()
  let expiring: ReturnType<typeof reader.read> | undefined
  try {
    await expiryHolder`BEGIN`
    await expiryHolder`SELECT farm_id FROM farm.memberships WHERE farm_id=${scope.farmId}::uuid AND account_id=${input.accountId} FOR UPDATE`
    expiring = reader.read({ ...scope, sessionRecordId: expiredSession })
    await waitForReaderLock()
    await expiryHolder`SELECT pg_sleep(0.65)`
    await expiryHolder`COMMIT`
    assert.equal(await expiring, null, 'Expiry during row wait must deny')
  } finally {
    try {
      await expiryHolder`ROLLBACK`
    } finally {
      expiryHolder.release()
      if (expiring) await expiring
    }
  }
  const expiry =
    await admin`SELECT revoked_at,absolute_expires_at FROM farm.account_sessions WHERE id=${expiredSession}`
  assert.notEqual(expiry[0]?.revoked_at, null)
  assert.ok(expiry[0], 'Expiry row must remain available for audit')
  return [
    'restricted-role-current-pause-negotiation-and-exact-scope',
    'membership-downgrade-after-real-row-wait-and-no-idle-refresh',
    'absolute-session-expiry-during-real-row-wait-terminal-denial',
  ]
}
