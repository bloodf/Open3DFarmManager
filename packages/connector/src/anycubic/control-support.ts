import {
  ControlArguments,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import { buildAnycubicCommand, supportedAnycubicActions } from './commands.ts'

export function anycubicControls(
  model: string,
): readonly ExtendedControlAction[] {
  return supportedAnycubicActions(model).length
    ? ['pause', 'resume', 'cancel', 'set_temperature', 'set_fan', 'set_light']
    : []
}

export function buildAnycubicControlCommand(
  action: ExtendedControlAction,
  args: Record<string, unknown>,
) {
  const parsed = ControlArguments.parse({ action, args })
  switch (parsed.action) {
    case 'pause':
    case 'resume':
      return buildAnycubicCommand(parsed.action)
    case 'cancel':
      return buildAnycubicCommand('stop')
    case 'set_temperature':
      if (parsed.args.heater === 'chamber') break
      return buildAnycubicCommand(
        parsed.args.heater === 'bed' ? 'bed' : 'nozzle',
        { value: parsed.args.target_c },
      )
    case 'set_fan':
      if (parsed.args.fan !== 'part') break
      return buildAnycubicCommand('fan', { value: parsed.args.percent })
    case 'set_light':
      return buildAnycubicCommand('light', { value: parsed.args.on ? 1 : 0 })
  }
  throw new Error('Anycubic control unavailable')
}
