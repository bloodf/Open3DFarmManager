import { test } from 'node:test'
import { deepStrictEqual, throws } from 'node:assert'
import {
  buildAnycubicCommand,
  supportedAnycubicActions,
} from '../../packages/connector/src/anycubic/commands.ts'

test('builds documented Kobra 3 command payloads', () => {
  deepStrictEqual(supportedAnycubicActions('unknown'), [])
  for (const action of ['pause', 'resume', 'stop'] as const) {
    const command = buildAnycubicCommand(action)
    deepStrictEqual(
      [command.type, command.action, command.data],
      ['print', action, { taskid: '-1' }],
    )
  }
  for (const [action, key, value] of [
    ['nozzle', 'target_nozzle_temp', 210],
    ['bed', 'target_hotbed_temp', 60],
    ['fan', 'fan_speed_pct', 75],
  ] as const) {
    deepStrictEqual(buildAnycubicCommand(action, { value }).data, {
      taskid: '-1',
      settings: { [key]: value },
    })
  }
  deepStrictEqual(buildAnycubicCommand('light', { value: 1 }).data, {
    type: 3,
    status: 1,
    brightness: 100,
  })
  throws(() => buildAnycubicCommand('fan', { value: 101 }))
  throws(() => buildAnycubicCommand('light', { value: 2 }))
})
