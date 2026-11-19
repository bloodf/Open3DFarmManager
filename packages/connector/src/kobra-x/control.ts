import {
  ControlArguments,
  controlSourceState,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import { createKobraXAce } from './ace.ts'
import { createKobraXActions } from './actions.ts'
import type { KobraXCall, KobraXControlContext } from './context.ts'
import { createKobraXFiles } from './files.ts'
import {
  refusedLocally,
  type KobraXOutcome,
  type KobraXRequests,
} from './requests.ts'
import type { KobraXFactsTracker } from './facts.ts'
import type { KobraXPrinterState } from './gate.ts'

/** The signed `printer-control` actions this adapter can carry out. */
export const KOBRA_X_CONTROLS: readonly ExtendedControlAction[] = Object.freeze(
  [
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'set_fan',
    'home',
    'set_light',
    'set_speed',
    'start_print',
    'load_filament',
    'unload_filament',
  ],
)

export function createKobraXControl(input: {
  requests: KobraXRequests
  facts: KobraXFactsTracker
  state(): KobraXPrinterState
  address: string
  httpPort: number
  token: string
  fetch?: typeof fetch
  resultTimeoutMs?: number
  motionResultTimeoutMs?: number
}) {
  let busy = false
  const context: KobraXControlContext = {
    ...input,
    claim() {
      if (busy) return undefined
      busy = true
      return () => {
        busy = false
      }
    },
  }
  const actions = createKobraXActions(context)
  const ace = createKobraXAce(context)
  const files = createKobraXFiles(context)

  /**
   * The signed-command entry point. `call.beforeSend` must be the Connector's
   * own last-moment authorization (signature, scope, freshness): without it
   * nothing is published. Returns the spec outcome, never a bare acknowledgement.
   */
  async function execute(
    action: ExtendedControlAction,
    args: Record<string, unknown>,
    call: KobraXCall,
  ): Promise<KobraXOutcome<unknown>> {
    const parsed = ControlArguments.safeParse({ action, args })
    if (!parsed.success) return refusedLocally('invalid-command')
    if (!KOBRA_X_CONTROLS.includes(action))
      return refusedLocally('unsupported-action')
    if (!controlSourceState(action, input.state()))
      return refusedLocally('state')
    const command = parsed.data
    switch (command.action) {
      case 'pause':
        return actions.pause(call)
      case 'resume':
        return actions.resume(call)
      case 'cancel':
        return actions.stop(call)
      case 'set_light':
        return actions.setLight(command.args.on, call)
      case 'set_fan':
        return command.args.fan === 'part'
          ? actions.setFan(command.args.percent, call)
          : refusedLocally('unsupported-fan')
      case 'set_speed':
        return actions.setSpeed(command.args.level, call)
      case 'home':
        // The printer homes all axes together; a partial homing is not offered.
        return ['x', 'y', 'z'].every((axis) =>
          (command.args.axes as string[]).includes(axis),
        )
          ? actions.home(call)
          : refusedLocally('unsupported-axes')
      case 'set_temperature':
        return command.args.heater === 'chamber'
          ? refusedLocally('unsupported-heater')
          : actions.setTemperature(
              command.args.heater,
              command.args.target_c,
              call,
            )
      case 'start_print':
        return files.start({ filename: command.args.file }, call)
      case 'load_filament':
        return command.args.tray === undefined
          ? refusedLocally('tray-required')
          : ace.feed(command.args.tray, call)
      case 'unload_filament':
        return ace.retract(call)
      default:
        return refusedLocally('unsupported-action')
    }
  }

  return Object.freeze({
    ...actions,
    ace,
    files,
    execute,
    /** What a farm page may offer for this printer. Never part of the status snapshot. */
    advertised: () => KOBRA_X_CONTROLS,
  })
}
export type KobraXControl = ReturnType<typeof createKobraXControl>
