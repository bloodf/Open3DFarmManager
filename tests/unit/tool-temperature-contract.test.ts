import { actionsForControlRole } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'
import { describe, expect, test } from 'vitest'
import {
  ControlArguments,
  controlRoleAllowed,
  controlSourceState,
} from '../../packages/farm-protocol/src/control-actions.ts'
import {
  ApiEnvelopeAction,
  scopeForApiAction,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import { ToolHeaters } from '../../packages/farm-protocol/src/state.ts'
import {
  buildToolTemperatureArgs,
  toolHeaterOptions,
} from '../../apps/farm/app/utils/farm-control-extended.ts'

describe('tool temperature contract', () => {
  test('accepts only strict, nonnegative integer arguments for tools 0 through 3', () => {
    const command = (tool: unknown, target_c: unknown) => ({
      action: 'set_tool_temperature',
      args: { tool, target_c },
    })
    expect(ControlArguments.safeParse(command(0, 0)).success).toBe(true)
    expect(ApiEnvelopeAction.safeParse(command(3, 250)).success).toBe(true)
    for (const [tool, target] of [
      [-1, 0],
      [4, 0],
      [1.5, 0],
      [0, -1],
      [0, 1.5],
    ])
      expect(ControlArguments.safeParse(command(tool, target)).success).toBe(
        false,
      )
    expect(
      ControlArguments.safeParse({
        ...command(0, 1),
        args: { tool: 0, target_c: 1, extra: true },
      }).success,
    ).toBe(false)
    expect(scopeForApiAction('set_tool_temperature')).toBe('control:extended')
    expect(controlRoleAllowed('operator', 'set_tool_temperature')).toBe(true)
    expect(actionsForControlRole('operator', ['set_tool_temperature'])).toEqual(
      ['set_tool_temperature'],
    )
    for (const state of ['printing', 'paused', 'error', 'unknown', 'cancelled'])
      expect(controlSourceState('set_tool_temperature', state)).toBe(false)
    expect(controlSourceState('set_tool_temperature', 'idle')).toBe(true)
  })
  test('advertisements are nonempty, unique and bounded', () => {
    expect(
      ToolHeaters.safeParse([
        { tool: 0, maxC: 0 },
        { tool: 3, maxC: 300 },
      ]).success,
    ).toBe(true)
    for (const heaters of [
      [],
      [{ tool: 4, maxC: 10 }],
      [{ tool: 1, maxC: -1 }],
      [
        { tool: 1, maxC: 2 },
        { tool: 1, maxC: 3 },
      ],
    ])
      expect(ToolHeaters.safeParse(heaters).success).toBe(false)
    expect(buildToolTemperatureArgs({ tool: 3, maxC: 200 }, '0')).toEqual({
      tool: 3,
      target_c: 0,
    })
  })
})

test('UI lists only advertised tool inputs with their limits', () => {
  expect(buildToolTemperatureArgs({ tool: 0, maxC: 200 }, 201)).toBeUndefined()
  expect(buildToolTemperatureArgs({ tool: 0, maxC: 200 }, '')).toBeUndefined()
  expect(toolHeaterOptions(undefined)).toEqual([])
  expect(
    toolHeaterOptions([
      { tool: 3, maxC: 275 },
      { tool: 0, maxC: 200 },
    ]),
  ).toEqual([
    { tool: 3, maxC: 275, label: 'Ferramenta T3' },
    { tool: 0, maxC: 200, label: 'Ferramenta T0' },
  ])
})
