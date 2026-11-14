import {
  ExtendedControlAction,
  MOONRAKER_CONTROLS,
} from '../../../farm-protocol/src/control-actions.ts'
import { supportedBambuActions } from './commands.ts'

/**
 * Actions to advertise for one control-enabled Bambu printer. The model is a
 * local provisioning fact; without it only the lifecycle actions are offered.
 */
export function bambuControls(
  model: string | undefined,
): readonly ExtendedControlAction[] {
  if (model === undefined) return MOONRAKER_CONTROLS
  const supported = supportedBambuActions(model)
  return Object.freeze(
    ExtendedControlAction.options.filter((action) =>
      supported.includes(action),
    ),
  )
}
