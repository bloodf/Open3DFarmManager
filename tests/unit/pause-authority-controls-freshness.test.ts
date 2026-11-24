import { describe, expect, test } from 'vitest'
import { freshAdvertisedActions } from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import { OBSERVATION_FRESH_MS } from '../../apps/farm/server/utils/integration-telemetry.ts'

describe('advertised controls used for issuance', () => {
  test('rejects missing, stale, malformed and future observations', () => {
    const now = OBSERVATION_FRESH_MS + 10
    expect(freshAdvertisedActions(undefined, undefined, now)).toEqual([])
    expect(freshAdvertisedActions(['start_print'], 9, now)).toEqual([])
    expect(freshAdvertisedActions(['start_print'], now + 1, now)).toEqual([])
    expect(freshAdvertisedActions(null, now, now)).toEqual([])
  })

  test('uses fresh controls again when a hold is released', () => {
    const now = OBSERVATION_FRESH_MS + 10
    expect(freshAdvertisedActions(['pause'], now, now)).toEqual(['pause'])
    expect(
      freshAdvertisedActions(
        ['pause', 'start_print', 'start_library_print'],
        now + 1,
        now + 1,
      ),
    ).toEqual(['pause', 'start_print', 'start_library_print'])
    expect(freshAdvertisedActions(['start_print'], 10, now)).toEqual([
      'start_print',
    ])
  })
})
