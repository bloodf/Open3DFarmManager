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
  jog: 'Mover eixo',
  motors_off: 'Desligar motores',
  z_babystep: 'Ajuste fino do Z',
  set_factor: 'Definir velocidade e fluxo',
  extrude: 'Extrudar filamento',
}
export function extendedLabel(action: ExtendedControlAction): string {
  return labels[action] ?? action
}
export function advertisedExtended(
  actions: readonly ExtendedControlAction[] | undefined,
): FarmExtendedAction[] {
  return extendedActions.filter((action) => actions?.includes(action))
}
/**
 * Commands a printer that advertises its controls does not offer. The page
 * names them as unsupported instead of hiding them. A printer that advertises
 * nothing (no control path) lists none.
 */
export function unsupportedExtended(
  actions: readonly ExtendedControlAction[] | undefined,
): ExtendedControlAction[] {
  if (actions === undefined) return []
  const known: readonly ExtendedControlAction[] = [
    ...extendedActions,
    'load_filament',
    'unload_filament',
  ]
  return known.filter((action) => !actions.includes(action))
}
export function buildExtendedArgs(
  action: FarmExtendedAction,
  choice: string,
  input: string | number,
): Record<string, unknown> | undefined {
  // A number input bound with v-model yields a number, not its text.
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
