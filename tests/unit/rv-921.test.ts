import { expect, test } from 'vitest'
import type { Sql } from 'postgres'
import { PostgresIntegrationActions } from '../../apps/farm/server/storage/integration-actions-postgres.ts'

test('an action target keeps an unreported list apart from a stale one', async () => {
  const printer = '22222222-2222-4222-8222-222222222222'
  const target = (controls: unknown) =>
    new PostgresIntegrationActions((async () => [
      {
        farmId: 'farm',
        agentId: 'agent',
        controls,
        observedAt: null,
        receivedAt: null,
        ageAtSendMs: null,
        now: 10_000_000,
      },
    ]) as unknown as Sql).target(printer)
  // No list: the service still defers basic actions to the Connector.
  expect((await target(null))?.controls).toBeNull()
  // A list without a trusted receipt time grants nothing.
  expect((await target(['pause', 'cancel']))?.controls).toEqual([])
})
