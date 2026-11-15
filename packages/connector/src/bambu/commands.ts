const actions = [
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
    keys(action === 'load_filament' ? ['tray', 'target_c'] : ['target_c'])
    const target = action === 'unload_filament' ? 255 : args.tray
    if (
      !Number.isInteger(target) ||
      (action === 'load_filament' &&
        ((target as number) < 0 || (target as number) > 15)) ||
      !Number.isFinite(args.target_c) ||
      (args.target_c as number) < 0 ||
      (args.target_c as number) > 300
    )
      throw new Error('Invalid filament request')
    return {
      print: {
        command: 'ams_change_filament',
        target,
        curr_temp: args.target_c,
        tar_temp: args.target_c,
        sequence_id,
      },
    }
  }
  if (action === 'set_temperature') {
    keys(['heater', 'target_c'])
    const max =
      args.heater === 'extruder' ? 300 : args.heater === 'bed' ? 120 : -1
    if (
      !Number.isInteger(args.target_c) ||
      (args.target_c as number) < 0 ||
      (args.target_c as number) > max
    )
      throw new Error('Invalid temperature')
    return print(
      'gcode_line',
      `M${args.heater === 'extruder' ? 104 : 140} S${args.target_c}\n`,
    )
  }
  if (action === 'set_fan') {
    keys(['fan', 'percent'])
    const fan = ['part', 'aux', 'chamber'].indexOf(args.fan as string) + 1
    if (
      !fan ||
      !Number.isInteger(args.percent) ||
      (args.percent as number) < 0 ||
      (args.percent as number) > 100
    )
      throw new Error('Invalid fan')
    return print(
      'gcode_line',
      `M106 P${fan} S${Math.round(((args.percent as number) * 255) / 100)}\n`,
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
    keys(['file'])
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
        param: 'Metadata/plate_1.gcode',
        url: `file:///sdcard/${encodeURIComponent(args.file)}`,
        sequence_id,
      },
    }
  }
  throw new Error('Unsupported Bambu action')
}
