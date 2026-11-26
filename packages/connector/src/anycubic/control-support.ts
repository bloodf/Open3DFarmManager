import {
  ControlArguments,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import { buildAnycubicCommand, supportedAnycubicActions } from './commands.ts'
import {
  ANYCUBIC_QUALIFIED_WRITES,
  anycubicLanModel,
  anycubicWriteQualified,
  type AnycubicQualification,
} from './models.ts'

/**
 * The Kobra 3 (20024) set does not depend on firmware. A model of `models.ts`
 * offers nothing unless the firmware it reported is in a qualified pair, and
 * never `start_print`: the start request of these models is not built here.
 */
export function anycubicControls(
  model: string,
  firmware?: string,
  qualified: readonly AnycubicQualification[] = ANYCUBIC_QUALIFIED_WRITES,
): readonly ExtendedControlAction[] {
  if (supportedAnycubicActions(model).length)
    return [
      'pause',
      'resume',
      'cancel',
      'set_temperature',
      'set_fan',
      'set_light',
      'start_print',
    ]
  if (
    firmware === undefined ||
    !anycubicWriteQualified(model, firmware, qualified)
  )
    return []
  return [
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'set_fan',
    ...(anycubicLanModel(model)!.chamberLight ? ['set_light' as const] : []),
  ]
}

export function buildAnycubicControlCommand(
  action: ExtendedControlAction,
  args: Record<string, unknown>,
  modelId = '',
) {
  const model = anycubicLanModel(modelId)
  const parsed = ControlArguments.parse({ action, args })
  switch (parsed.action) {
    case 'pause':
    case 'resume':
      return buildAnycubicCommand(parsed.action)
    case 'cancel':
      return buildAnycubicCommand('stop')
    case 'set_temperature':
      if (parsed.args.heater === 'chamber') break
      if (
        model &&
        parsed.args.heater === 'bed' &&
        parsed.args.target_c > model.bedMaxCelsius
      )
        break
      return buildAnycubicCommand(
        parsed.args.heater === 'bed' ? 'bed' : 'nozzle',
        { value: parsed.args.target_c },
      )
    case 'set_fan':
      if (parsed.args.fan !== 'part') break
      return buildAnycubicCommand('fan', { value: parsed.args.percent })
    case 'set_light':
      if (model && !model.chamberLight) break
      return buildAnycubicCommand('light', {
        value: parsed.args.on ? 1 : 0,
        ...(model ? { lightType: 2 as const } : {}),
      })
  }
  throw new Error('Anycubic control unavailable')
}
