import { expect, test } from 'vitest'
import type { Sql } from 'postgres'
import { OBSERVATION_FRESH_MS } from '../../apps/farm/server/utils/integration-telemetry.ts'
import { PostgresIntegrationActions } from '../../apps/farm/server/storage/integration-actions-postgres.ts'

test('an action target keeps an unreported list apart from a stale one', async () => {
  const printer = '22222222-2222-4222-8222-222222222222'
  const now = 10_000_000
  const target = (controls: unknown, receivedAt: number | null = null) =>
    new PostgresIntegrationActions((async () => [
      {
        farmId: 'farm',
        agentId: 'agent',
        controls,
        observedAt: receivedAt,
        receivedAt,
        ageAtSendMs: 0,
        now,
      },
    ]) as unknown as Sql).target(printer)
  // No list: the service still defers basic actions to the Connector.
  expect((await target(null))?.controls).toBeNull()
  expect(
    (
      await target(
        ['pause', 'cancel', 'resume'],
        now - OBSERVATION_FRESH_MS - 1,
      )
    )?.controls,
  ).toEqual(['pause', 'cancel'])
  // A list without a trusted receipt time grants nothing.
  expect((await target(['pause', 'cancel']))?.controls).toEqual([])
})
