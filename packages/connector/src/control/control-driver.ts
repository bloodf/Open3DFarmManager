import type { z } from 'zod'
import type { ToolHeaters } from '../../../farm-protocol/src/state.ts'
import type {
  ExtendedControlAction,
  ToolTemperatureArgs,
} from '../../../farm-protocol/src/control-actions.ts'
import type { PreparedPauseDriver } from './pause-dispatcher.ts'
import type { PrinterBinding } from './printer-binding.ts'

/** Locally registered backend support; wire claims never select a driver. */
export interface ControlDriver extends PreparedPauseDriver {
  controls(binding: PrinterBinding): readonly ExtendedControlAction[]
}

/** Validate only the Connector's latest local observation. */
export function toolTemperatureRefusal(
  observation: Readonly<{
    ready: boolean
    printState: string
    toolHeaters?: readonly ToolHeaters[number][] | undefined
  }> | null,
  args: z.infer<typeof ToolTemperatureArgs>,
) {
  if (!observation) return 'tool-state-stale'
  if (!observation.ready || observation.printState !== 'idle')
    return 'tool-printer-not-idle'
  const heater = observation.toolHeaters?.find(({ tool }) => tool === args.tool)
  if (!heater) return 'tool-heater-not-advertised'
  if (args.target_c > heater.maxC) return 'tool-temperature-above-maximum'
}
