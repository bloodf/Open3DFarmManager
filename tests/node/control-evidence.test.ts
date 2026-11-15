import test from 'node:test'
import assert from 'node:assert/strict'
import {
  controlEffectMatches,
  type ControlObservation,
} from '../../packages/connector/src/control/pause-dispatcher.ts'
import { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'

const base: ControlObservation = {
  assignmentId: '00000000-0000-4000-8000-000000000001',
  printerKey: 'synthetic',
  connectionGeneration: 1,
  sequence: 2,
  ready: true,
  printState: 'idle',
  readyObservedMono: 12,
  printStateObservedMono: 12,
  receivedMono: 12,
}
const cases = [
  {
    action: 'start_print',
    args: { file: 'job.gcode' },
    effect: { kind: 'file', filename: 'job.gcode', observedMono: 12 },
  },
  {
    action: 'set_temperature',
    args: { heater: 'bed', target_c: 60 },
    effect: {
      kind: 'temperature',
      heater: 'bed',
      target_c: 60,
      observedMono: 12,
    },
  },
  {
    action: 'set_fan',
    args: { fan: 'part', percent: 80 },
    effect: { kind: 'fan', fan: 'part', percent: 79, observedMono: 12 },
  },
  {
    action: 'set_light',
    args: { on: false },
    effect: { kind: 'light', on: false, observedMono: 12 },
  },
] as const
for (const c of cases) {
  test(`${c.action} requires matching fresh evidence`, () => {
    const observation: ControlObservation = {
      ...base,
      printState: 'printing',
      effect: c.effect,
    }
    assert.equal(controlEffectMatches(c.action, c.args, observation, 10), true)
    assert.equal(controlEffectMatches(c.action, c.args, base, 10), false)
    assert.equal(controlEffectMatches(c.action, {}, observation, 10), false)
    assert.equal(controlEffectMatches(c.action, c.args, observation, 12), false)
    assert.equal(
      controlEffectMatches(
        c.action,
        c.args,
        { ...observation, receivedMono: 11 },
        10,
      ),
      false,
    )
  })
}
for (const action of ExtendedControlAction.options) {
  if (cases.some((c) => c.action === action)) continue
  test(`${action} confirms only a lifecycle target`, () => {
    const target =
      action === 'pause'
        ? 'paused'
        : action === 'resume'
          ? 'printing'
          : action === 'cancel'
            ? 'cancelled'
            : undefined
    for (const printState of [
      'idle',
      'printing',
      'paused',
      'cancelled',
      'unknown',
    ] as const)
      assert.equal(
        controlEffectMatches(action, {}, { ...base, printState }, 10),
        printState === target,
      )
  })
}
test('start requires the requested file and an active print', () => {
  const c = cases[0]
  assert.equal(
    controlEffectMatches(c.action, c.args, { ...base, effect: c.effect }, 10),
    false,
  )
  assert.equal(
    controlEffectMatches(
      c.action,
      c.args,
      { ...base, printState: 'paused', effect: c.effect },
      10,
    ),
    true,
  )
})
test('fan tolerance is at most one percentage point', () => {
  const c = cases[2]
  assert.equal(
    controlEffectMatches(
      c.action,
      c.args,
      { ...base, effect: { ...c.effect, percent: 78 } },
      10,
    ),
    false,
  )
})
