import type { ToolHeaters } from '../../../../packages/farm-protocol/src/state.ts'
import {
  ControlArguments,
  FILAMENT_SLOT_MATERIALS,
  SpeedMode,
  ToolTemperatureArgs,
  type ExtendedControlAction,
} from '../../../../packages/farm-protocol/src/control-actions.ts'

export const extendedActions = [
  'set_temperature',
  'set_tool_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
  'firmware_restart',
  'emergency_stop',
  'clear_hold',
  'set_camera_stream',
  'set_filament_slot',
] as const
/**
 * Model-specific writes and `clear_hold`, which is only advertised while a
 * command is stuck: shown when advertised, never listed as missing.
 */
const ADVERTISED_ONLY: ReadonlySet<ExtendedControlAction> = new Set([
  'set_tool_temperature',
  'set_camera_stream',
  'set_filament_slot',
  'clear_hold',
])
export const slotMaterials = FILAMENT_SLOT_MATERIALS
/** The signed slot record, or nothing while the form is incomplete. */
export function buildFilamentSlotArgs(
  tray: string,
  material: string,
  color: string,
): Record<string, unknown> | undefined {
  const args = {
    tray: tray === '' ? NaN : Number(tray),
    material,
    color: color.toUpperCase(),
  }
  return ControlArguments.safeParse({ action: 'set_filament_slot', args })
    .success
    ? args
    : undefined
}
/** What a printer setting write will change, said before it is signed. */
export function writeDialogDescription(
  action: ExtendedControlAction,
  args: Record<string, unknown>,
): string | undefined {
  const once = 'O comando não será repetido automaticamente.'
  if (action === 'set_camera_stream')
    return `${args.on === true ? 'Ligar' : 'Desligar'} a transmissão da câmera da impressora. ${once}`
  if (action === 'set_filament_slot')
    return `Registrar no compartimento ${Number(args.tray) + 1}: material ${String(args.material)}, cor ${String(args.color)}. Nenhum filamento será movido. ${once}`
}
export type FarmExtendedAction = (typeof extendedActions)[number]
const labels: Partial<Record<ExtendedControlAction, string>> = {
  config_write: 'Editar configuração',
  bed_mesh: 'Malha da mesa',
  set_temperature: 'Definir temperatura',
  set_tool_temperature: 'Definir temperatura da ferramenta',
  set_fan: 'Definir ventilador',
  home: 'Referenciar eixos',
  set_light: 'Definir luz',
  set_speed: 'Definir velocidade',
  power: 'Alterar energia do dispositivo',
  service: 'Reiniciar serviço',
  timelapse: 'Gerenciar timelapse',
  firmware_restart: 'Reiniciar firmware',
  emergency_stop: 'Parada de emergência',
  run_macro: 'Executar macro',
  load_filament: 'Carregar filamento',
  unload_filament: 'Descarregar filamento',
  jog: 'Mover eixo',
  motors_off: 'Desligar motores',
  z_babystep: 'Ajuste fino do Z',
  file_op: 'Gerenciar arquivos',
  set_factor: 'Definir velocidade e fluxo',
  exclude_object: 'Excluir objeto',
  extrude: 'Extrudar filamento',
  set_led: 'Definir LED',
  set_pin: 'Definir saída',
  queue_op: 'Gerenciar fila de impressão',
  gcode: 'Enviar G-code',
  confirm_collection: 'Confirmar placa livre',
  clear_hold: 'Liberar comando sem confirmação',
  set_camera_stream: 'Controlar transmissão da câmera',
  set_filament_slot: 'Salvar material do compartimento',
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
  return known.filter(
    (action) => !ADVERTISED_ONLY.has(action) && !actions.includes(action),
  )
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
    case 'set_camera_stream':
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
  return ['home', 'firmware_restart', 'emergency_stop', 'clear_hold'].includes(
    action,
  )
}

export function speedModeOptions(modes: readonly SpeedMode[] | undefined) {
  const labels: Record<SpeedMode, string> = {
    silent: 'Silenciosa',
    standard: 'Padrão',
    sport: 'Esportiva',
    ludicrous: 'Máxima',
  }
  return SpeedMode.options
    .filter((mode) => modes === undefined || modes.includes(mode))
    .map((value) => ({ value, label: labels[value] }))
}

export function toolHeaterOptions(
  heaters: readonly ToolHeaters[number][] | undefined,
) {
  return (heaters ?? []).map(({ tool, maxC }) => ({
    tool,
    maxC,
    label: `Ferramenta ${tool + 1}`,
  }))
}

export function buildToolTemperatureArgs(
  heater: ToolHeaters[number],
  input: string | number,
) {
  if (String(input).trim() === '') return
  const parsed = ToolTemperatureArgs.safeParse({
    tool: heater.tool,
    target_c: Number(input),
  })
  if (parsed.success && parsed.data.target_c <= heater.maxC) return parsed.data
}
