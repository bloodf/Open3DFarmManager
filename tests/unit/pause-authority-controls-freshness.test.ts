import type { TransactionSql } from 'postgres'
import type { TelemetryEvent } from '@open3dfarmmanager/farm-protocol'
import { describe, expect, test, vi } from 'vitest'
import { freshAdvertisedActions } from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import { recordLatestStates } from '../../apps/farm/server/storage/postgres-printer-latest-state.ts'
import { OBSERVATION_FRESH_MS } from '../../apps/farm/server/utils/integration-telemetry.ts'

describe('advertised controls used for issuance', () => {
  const now = 1_000_000
  const controls = ['pause', 'cancel', 'emergency_stop'] as const

  test.each([-20_000, 20_000])(
    'grants freshly received controls with Connector clock skew of %i ms',
    (skew) => {
      expect(freshAdvertisedActions(controls, now + skew, now, now)).toEqual(
        controls,
      )
    },
  )

  test('rejects missing, stale, malformed and implausibly future observations', () => {
    expect(freshAdvertisedActions(controls, now, null, now)).toEqual([])
    const staleReceipt = now - OBSERVATION_FRESH_MS - 1
    expect(
      freshAdvertisedActions(
        controls,
        staleReceipt + 20_000,
        staleReceipt,
        now,
      ),
    ).toEqual([])
    expect(freshAdvertisedActions(controls, now, now + 1, now)).toEqual([])
    expect(freshAdvertisedActions(controls, now + 30_001, now, now)).toEqual([])
    expect(freshAdvertisedActions(null, now, now, now)).toEqual([])
  })

  test('uses fresh controls again when a hold is released', () => {
    expect(freshAdvertisedActions(['pause'], now, now, now)).toEqual(['pause'])
    expect(
      freshAdvertisedActions(
        ['pause', 'start_print', 'start_library_print'],
        now + 1,
        now + 1,
        now + 1,
      ),
    ).toEqual(['pause', 'start_print', 'start_library_print'])
  })

  test('skips a far-future report and stores the next report for the same printer', async () => {
    const query = vi.fn(
      async (_sql: TemplateStringsArray, ..._params: unknown[]) => [],
    )
    const tx = Object.assign(query, {
      json: (value: unknown) => value,
    }) as unknown as TransactionSql
    const scope = { farmId: 'farm', agentId: 'agent' }
    const report = (
      observedAt: number,
    ): Extract<TelemetryEvent, { kind: 'printer-state' }> => ({
      kind: 'printer-state',
      eventId: String(observedAt),
      queuedAt: observedAt,
      state: {
        printerKey: 'simulator',
        observedAt,
        state: 'printing',
        progress: 0.5,
        controls: [...controls],
      },
    })
    await recordLatestStates(tx, scope, [report(now + 30_001)], now)
    expect(query).not.toHaveBeenCalled()

    const next = report(now + 20_000)
    await recordLatestStates(tx, scope, [next], now + 1)
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      scope.farmId,
      scope.agentId,
      next.state.printerKey,
      next.state.observedAt,
      next.state,
      now + 1,
      30_000,
    )
  })
})
