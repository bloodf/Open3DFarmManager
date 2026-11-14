import { describe, expect, it } from 'vitest'
import { actionsForControlRole } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'
import { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import { PauseCapabilityV1 } from '../../packages/farm-protocol/src/pause-capability.ts'

describe('authority actions', () => {
  const actions = [
    'pause',
    'resume',
    'cancel',
    'emergency_stop',
    'set_temperature',
    'set_fan',
    'home',
    'set_light',
    'set_speed',
    'start_print',
    'firmware_restart',
  ]
  for (const role of ['owner', 'admin', 'operator']) {
    it(`authorizes every action for ${role}`, () => {
      expect(actionsForControlRole(role)).toEqual(actions)
      for (const action of actions) {
        expect(ExtendedControlAction.safeParse(action).success).toBe(true)
      }
    })
  }
  for (const role of ['viewer', 'unknown', '']) {
    it(`issues no actions for ${role || 'an empty role'}`, () => {
      expect(actionsForControlRole(role)).toEqual([])
    })
  }
  it('rejects an unknown capability action', () => {
    expect(PauseCapabilityV1.shape.actions.safeParse(['unknown']).success).toBe(
      false,
    )
  })
})
