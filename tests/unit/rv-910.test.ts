import { expect, test } from 'vitest'
import { ExtendedControlAction } from '@open3dfarmmanager/farm-protocol'
import { freshAdvertisedActions } from '../../apps/farm/server/storage/postgres-pause-authority.ts'

test.each([null, undefined])(
  'only advertised stop actions can use the age fallback (%s)',
  (age) => {
    const now = 10_000_000
    const controls = ExtendedControlAction.options
    expect(freshAdvertisedActions(controls, age, now, now, now)).toEqual([
      'pause',
      'cancel',
      'emergency_stop',
    ])
    expect(
      freshAdvertisedActions(controls, age, now, now, now - 3_600_000),
    ).toEqual(['pause', 'cancel', 'emergency_stop'])
    expect(
      freshAdvertisedActions(['jog', 'cancel'], age, now, now, now),
    ).toEqual(['cancel'])
    expect(freshAdvertisedActions(controls, 0, now, now, now)).toEqual(controls)
  },
)
