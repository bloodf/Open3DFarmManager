import {
  buildBambuConsoleLine,
  buildBambuExtrude,
  buildBambuJog,
} from './printer-detail.ts'
import { buildBambuFilamentCommand } from './filament.ts'

/*
 * Temperature and fan wire formats: bambulab/BambuStudio (AGPL-3.0), commit
 * 23a33758933e712c6041e1f8f135f7d6b50004aa, under src/slic3r/GUI/:
 * - DeviceManager.cpp `command_set_nozzle` (M104), `command_set_nozzle_new`
 *   (`set_nozzle_temp`), `command_set_bed` (`set_bed_temp` when bit 39 of the
 *   reported `fun` word is set, else M140).
 * - DeviceCore/DevChamberCtrl.cpp `CtrlSetChamberTemp` (`set_ctt`).
 * - DeviceCore/DevFan.cpp `command_control_fan` (M106 P1 part, P2 aux,
 *   P3 chamber, 0-255) and `command_control_fan_new` (`set_fan`, percent),
 *   chosen in Widgets/FanControl.cpp by whether `device.airduct` is reported.
 * - resources/printers/*.json `support_chamber_temp_edit_range`.
 */

/** Chamber heater limit by provisioned model name or model code. */
const CHAMBER_MAX_C: Readonly<Record<string, number>> = {
  x1e: 60,
  c13: 60,
  x2d: 65,
  n6: 65,
  h2c: 65,
  o1c: 65,
  o1c2: 65,
  h2d: 65,
  o1d: 65,
  h2dpro: 65,
  o1e: 65,
  h2s: 65,
  o1s: 65,
  h3c: 65,
  n10: 65,
}

/** Undefined: this model has no settable chamber heater, or is unknown. */
export function bambuChamberMaxC(model: string | undefined) {
  const key = model?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? ''
  return Object.hasOwn(CHAMBER_MAX_C, key) ? CHAMBER_MAX_C[key] : undefined
}

const actions = [
  'pause',
  'resume',
  'cancel',
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'jog',
  'extrude',
  // The signed console action (E18.1) joins the protocol enum separately.
  'gcode',
  'set_speed',
  'start_print',
  'load_filament',
  'unload_filament',
] as const
export function supportedBambuActions(_model: string): readonly string[] {
  return [...actions]
}
export function buildBambuCommand(
  action: string,
  args: Record<string, unknown>,
) {
  const sequence_id = args.sequence_id ?? '0'
  if (typeof sequence_id !== 'string' || !/^\d{1,16}$/.test(sequence_id))
    throw new Error('Invalid sequence')
  const keys = (allowed: string[]) => {
    if (
      Object.keys(args).some(
        (key) => !['sequence_id', ...allowed].includes(key),
      )
    )
      throw new Error('Invalid arguments')
  }
  const print = (command: string, param?: string) => ({
    print: { command, ...(param === undefined ? {} : { param }), sequence_id },
  })
  if (['pause', 'resume', 'cancel'].includes(action)) {
    keys([])
    return print(action === 'cancel' ? 'stop' : action)
  }
  if (action === 'load_filament' || action === 'unload_filament') {
    // ams_id is the loaded unit the control driver reads for an unload.
    keys(
      action === 'load_filament'
        ? ['tray', 'target_c']
        : ['target_c', 'ams_id'],
    )
    const target = action === 'unload_filament' ? 255 : args.tray
    if (
      typeof target !== 'number' ||
      (action === 'load_filament' && target === 255) ||
      typeof args.target_c !== 'number'
    )
      throw new Error('Invalid filament request')
    return buildBambuFilamentCommand(
      target,
      args.target_c,
      sequence_id,
      args.ams_id as number | undefined,
    )
  }
  const temperature = (value: unknown, max: number): value is number =>
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= max
  if (action === 'set_temperature') {
    // chamber_max_c and mqtt_bed are added by the control driver from the
    // local model and the live report; never wire input.
    keys(['heater', 'target_c', 'chamber_max_c', 'mqtt_bed'])
    const max =
      args.heater === 'extruder'
        ? 300
        : args.heater === 'bed'
          ? 120
          : args.heater === 'chamber' && typeof args.chamber_max_c === 'number'
            ? args.chamber_max_c
            : -1
    const target = args.target_c
    if (!temperature(target, max)) throw new Error('Invalid temperature')
    if (args.heater === 'chamber')
      return { print: { command: 'set_ctt', ctt_val: target, sequence_id } }
    if (args.heater === 'bed' && args.mqtt_bed === true)
      return {
        print: { command: 'set_bed_temp', temp: target, sequence_id },
      }
    return print(
      'gcode_line',
      `M${args.heater === 'extruder' ? 104 : 140} S${target}\n`,
    )
  }
  if (action === 'set_tool_temperature') {
    // Dual-nozzle request: 0 is the main (right) extruder, 1 the left.
    // Built here but not advertised on the signed path.
    keys(['tool', 'target_c'])
    if (
      (args.tool !== 0 && args.tool !== 1) ||
      !temperature(args.target_c, 300)
    )
      throw new Error('Invalid temperature')
    return {
      print: {
        command: 'set_nozzle_temp',
        extruder_index: args.tool,
        target_temp: args.target_c,
        sequence_id,
      },
    }
  }
  if (action === 'set_fan') {
    // airduct is added by the control driver from the live report.
    keys(['fan', 'percent', 'airduct'])
    const fan = ['part', 'aux', 'chamber'].indexOf(args.fan as string) + 1
    if (!fan || !temperature(args.percent, 100)) throw new Error('Invalid fan')
    if (args.airduct === true)
      return {
        print: {
          command: 'set_fan',
          fan_index: fan,
          speed: args.percent,
          sequence_id,
        },
      }
    return print(
      'gcode_line',
      `M106 P${fan} S${Math.round((args.percent * 255) / 100)}\n`,
    )
  }
  if (action === 'home') {
    keys(['axes'])
    if (
      !Array.isArray(args.axes) ||
      !args.axes.length ||
      new Set(args.axes).size !== args.axes.length ||
      args.axes.some((axis) => !['x', 'y', 'z'].includes(axis))
    )
      throw new Error('Invalid axes')
    return print(
      'gcode_line',
      `G28 ${args.axes.map((axis: string) => axis.toUpperCase()).join(' ')}\n`,
    )
  }
  if (action === 'jog') {
    keys(['axis', 'distance_mm', 'feed'])
    const { sequence_id: _, ...jog } = args
    return buildBambuJog(jog, sequence_id)
  }
  if (action === 'extrude') {
    // nozzle_c is the live reading the control driver adds; never wire input.
    keys(['tool', 'length_mm', 'feed', 'nozzle_c'])
    const { sequence_id: _, nozzle_c, ...extrude } = args
    return buildBambuExtrude(extrude, nozzle_c, sequence_id)
  }
  if (action === 'gcode') {
    // print_state is the live gcode_state the control driver adds.
    keys(['line', 'print_state'])
    return buildBambuConsoleLine(args.line, args.print_state, sequence_id)
  }
  if (action === 'set_light') {
    keys(['on'])
    if (typeof args.on !== 'boolean') throw new Error('Invalid light')
    return {
      system: {
        command: 'ledctrl',
        led_node: 'chamber_light',
        led_mode: args.on ? 'on' : 'off',
        sequence_id,
      },
    }
  }
  if (action === 'set_speed') {
    keys(['level'])
    const level =
      ['silent', 'standard', 'sport', 'ludicrous'].indexOf(
        args.level as string,
      ) + 1
    if (!level) throw new Error('Invalid speed')
    return print('print_speed', String(level))
  }
  if (action === 'start_print') {
    keys(['file', 'plate', 'ams_mapping'])
    const plate = args.plate ?? 1
    const mapping = args.ams_mapping
    if (
      !Number.isInteger(plate) ||
      (plate as number) < 1 ||
      (plate as number) > 1000 ||
      (mapping !== undefined &&
        (!Array.isArray(mapping) ||
          mapping.length > 64 ||
          mapping.some(
            (slot) => !Number.isInteger(slot) || slot < -1 || slot > 255,
          )))
    )
      throw new Error('Invalid plate or AMS mapping')
    if (
      typeof args.file !== 'string' ||
      !args.file.length ||
      args.file.length > 255 ||
      /[/\\\x00-\x1f\x7f]/.test(args.file) ||
      args.file.includes('..')
    )
      throw new Error('Invalid file')
    return {
      print: {
        command: 'project_file',
        param: `Metadata/plate_${plate}.gcode`,
        url: `file:///sdcard/${encodeURIComponent(args.file)}`,
        ...(mapping
          ? { ams_mapping: mapping, use_ams: mapping.some((slot) => slot >= 0) }
          : {}),
        sequence_id,
      },
    }
  }
  throw new Error('Unsupported Bambu action')
}
