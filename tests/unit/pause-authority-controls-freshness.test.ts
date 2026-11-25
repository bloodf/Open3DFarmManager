import type { TransactionSql } from 'postgres'
import type { TelemetryEvent } from '@open3dfarmmanager/farm-protocol'
import { describe, expect, test, vi } from 'vitest'
import { freshAdvertisedActions } from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import { recordLatestStates } from '../../apps/farm/server/storage/postgres-printer-latest-state.ts'
import { OBSERVATION_FRESH_MS } from '../../apps/farm/server/utils/integration-telemetry.ts'

describe('advertised controls used for issuance', () => {
  const now = 1_000_000
  const controls = ['pause', 'cancel', 'emergency_stop'] as const

  test('grants controls when send age plus database receipt age is within the window', () => {
    expect(freshAdvertisedActions(controls, 20_000, now - 1000, now)).toEqual(
      controls,
    )
  })

  test('rejects missing, malformed and implausible ages and receipts', () => {
    expect(freshAdvertisedActions(controls, 0, null, now)).toEqual([])
    expect(freshAdvertisedActions(controls, undefined, now, now)).toEqual([])
    expect(freshAdvertisedActions(controls, -1, now, now)).toEqual([])
    expect(freshAdvertisedActions(controls, 0, now + 1, now)).toEqual([])
    expect(freshAdvertisedActions(null, 0, now, now)).toEqual([])
  })

  test('keeps advertised stops when the observation is stale', () => {
    const advertised = [...controls, 'resume']
    const staleReceipt = now - OBSERVATION_FRESH_MS - 1
    expect(freshAdvertisedActions(advertised, 0, staleReceipt, now)).toEqual(
      controls,
    )
    expect(
      freshAdvertisedActions(advertised, OBSERVATION_FRESH_MS + 1, now, now),
    ).toEqual(controls)
    expect(
      freshAdvertisedActions(advertised, OBSERVATION_FRESH_MS, now - 1, now),
    ).toEqual(controls)
  })

  test('uses fresh controls again when a hold is released', () => {
    expect(freshAdvertisedActions(['pause'], 0, now, now)).toEqual(['pause'])
    expect(
      freshAdvertisedActions(
        ['pause', 'start_print', 'start_library_print'],
        0,
        now + 1,
        now + 1,
      ),
    ).toEqual(['pause', 'start_print', 'start_library_print'])
  })

  test('stores a far-future report and its successor after a Connector clock step', async () => {
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
    const future = report(now + 30_001)
    const next = { ...report(now - 30_001), ageAtSendMs: 100 }
    await recordLatestStates(tx, scope, [future, next])
    expect(query).toHaveBeenCalledTimes(2)
    for (const [index, event] of [future, next].entries()) {
      expect(query).toHaveBeenNthCalledWith(
        index + 1,
        expect.anything(),
        scope.farmId,
        scope.agentId,
        event.state.printerKey,
        event.state.observedAt,
        event.state,
        event.ageAtSendMs ?? null,
      )
      const statement = query.mock.calls[index]![0].join('')
      expect(statement).toContain('pg_catalog.clock_timestamp()')
      expect(statement).toContain(
        'revision = printer_latest_state.revision + 1',
      )
      expect(statement).not.toMatch(/WHERE.*observed_at/)
    }
  })
})
