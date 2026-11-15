import {
  ControlArguments,
  type ExtendedControlAction,
} from '../../../../packages/farm-protocol/src/control-actions.ts'

export const extendedActions = [
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
  'firmware_restart',
  'emergency_stop',
] as const
export type FarmExtendedAction = (typeof extendedActions)[number]
const labels: Partial<Record<ExtendedControlAction, string>> = {
  set_temperature: 'Definir temperatura',
  set_fan: 'Definir ventilador',
  home: 'Referenciar eixos',
  set_light: 'Definir luz',
  set_speed: 'Definir velocidade',
  firmware_restart: 'Reiniciar firmware',
  emergency_stop: 'Parada de emergência',
  run_macro: 'Executar macro',
  load_filament: 'Carregar filamento',
  unload_filament: 'Descarregar filamento',
}
export function extendedLabel(action: ExtendedControlAction): string {
  return labels[action] ?? action
}
export function advertisedExtended(
  actions: readonly ExtendedControlAction[] | undefined,
): FarmExtendedAction[] {
  return extendedActions.filter((action) => actions?.includes(action))
}
/** Extended actions the Connector does not advertise for this printer. */
export function unadvertisedExtended(
  actions: readonly ExtendedControlAction[] | undefined,
): FarmExtendedAction[] {
  return actions ? extendedActions.filter((a) => !actions.includes(a)) : []
}
export function buildExtendedArgs(
  action: FarmExtendedAction,
  choice: string,
  // A numeric input's model is a number once the operator types in it.
  input: string | number,
): Record<string, unknown> | undefined {
  const value = String(input)
  let args: Record<string, unknown>
  switch (action) {
    case 'set_temperature':
      args = {
        heater: choice,
        target_c: value.trim() === '' ? NaN : Number(value),
      }
      break
    case 'set_fan':
      args = { fan: choice, percent: value.trim() === '' ? NaN : Number(value) }
      break
    case 'home':
      args = { axes: ['x', 'y', 'z'] }
      break
    case 'set_light':
      args = { on: choice === 'on' }
      if (!['on', 'off'].includes(choice)) return
      break
    case 'set_speed':
      args = { level: choice }
      break
    default:
      args = {}
  }
  if (!ControlArguments.safeParse({ action, args }).success) return
  if (
    action === 'set_temperature' &&
    (args.target_c as number) >
      ({ extruder: 300, bed: 120, chamber: 65 }[choice] ?? -1)
  )
    return
  return args
}
export function requiresExtendedConfirmation(
  action: FarmExtendedAction,
): boolean {
  return ['home', 'firmware_restart', 'emergency_stop'].includes(action)
}
