import { createSpoolMembershipReader } from '../../packages/connector/src/runtime/api-query.ts'
import type { SpoolmanSnapshot } from '../../packages/connector/src/runtime/spoolman-provider.ts'
import { expect, test, vi } from 'vitest'

const farmId = '00000000-0000-4000-8000-000000000001'
const serviceId = '00000000-0000-4000-8000-000000000002'

function snapshot(observedFrom: number, ageMs: number): SpoolmanSnapshot {
  return {
    kind: 'observed' as const,
    ageMs,
    inventory: {
      farmId,
      serviceId,
      observedFrom,
      observedThrough: observedFrom,
      items: [
        {
          id: 99,
          filament: {
            id: 1,
            name: 'PLA',
            material: 'PLA',
            color_hex: null,
            density: null,
            diameter: null,
            vendor: null,
            spool_weight: null,
            weight: null,
            extra: {},
          },
          initial_weight: null,
          spool_weight: null,
          used_weight: null,
          lot_nr: null,
          remaining_weight: null,
          location: null,
          archived: false,
          extra: {},
        },
      ],
    },
  }
}

const query = {
  v: 1 as const,
  t: 'connector.api-query' as const,
  request_id: '00000000-0000-4000-8000-000000000003',
  kind: 'spool-membership' as const,
  farmId,
  serviceId,
  spoolId: 99,
}

test('does not answer membership once the inventory freshness deadline expires', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(100_000)
    const reader = createSpoolMembershipReader()
    reader.update(snapshot(100_000, 0))
    expect(reader.read(query)?.present).toBe(true)
    vi.advanceTimersByTime(30_000)
    expect(reader.read(query)).toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})

test('clamps observedAt to the Connector wall clock when inventory time is ahead', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(100_000)
    const reader = createSpoolMembershipReader()
    reader.update(snapshot(120_000, 0))
    expect(reader.read(query)?.observedAt).toBe(100_000)
  } finally {
    vi.useRealTimers()
  }
})
