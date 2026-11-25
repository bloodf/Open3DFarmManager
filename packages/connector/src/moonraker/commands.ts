import { DriverRefusalError } from '../control/driver-refusal.ts'
import {
  bedMeshScript,
  bedMeshSupported,
  BedMeshRefused,
} from './control-bed-mesh.ts'
import { advertisedMoonrakerMacros } from '../control/macro-support.ts'
import { buildConsoleScript } from './control-console.ts'
import { buildMacroScript } from './control-macros.ts'
import {
  buildMotionScript,
  isMotionAction,
  motionSupported,
} from './control-motion.ts'
import {
  ControlArguments,
  PrinterGcodePath,
} from '../../../farm-protocol/src/control-actions.ts'
import { POWER_MARKER, powerCommand } from './control-power.ts'
import { serviceCommand } from './control-system-services.ts'
import { parseTimelapseOp, timelapseSupported } from './control-timelapse.ts'
import { parseExtrude } from './control-extrusion.ts'
import {
  ledNames,
  ledScript,
  namedFanScript,
  OutputRefused,
  pinNames,
  pinScript,
} from './control-outputs.ts'
import { parseQueueOp, queueSupported } from './control-job-queue.ts'
import {
  SNAPMAKER_U1_MARKER,
  SnapmakerU1CommandRefused,
  snapmakerU1Controls,
  U1_MAX_BED_C,
  U1_MAX_TOOL_C,
  U1_TOOL_OBJECTS,
} from './u1-marker.ts'
/**
 * Moonraker extended command builder and capability inspection.
 * Translates extended printer actions into Moonraker JSON-RPC calls.
 */

export const MOONRAKER_EXTENDED_ACTIONS = [
  'pause',
  'resume',
  'cancel',
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
  'emergency_stop',
] as const

export type MoonrakerExtendedAction =
  (typeof MOONRAKER_EXTENDED_ACTIONS)[number]

export interface MoonrakerRpcCall {
  method: string
  params?: Record<string, unknown>
}

// Whitelist validator for G-code safe names (Klipper identifiers: lowercase/uppercase alphanumeric, underscore)
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_]+$/

/**
 * Format fan speed (0.0 to 1.0) without trailing zeroes.
 */
function formatFanSpeed(speed255: number): string {
  const fraction = speed255 / 255
  return Number(fraction.toFixed(2)).toString()
}

/**
 * Determine supported extended actions given the objects exposed by printer.objects.list.
 */
export function supportedMoonrakerActions(
  objects: readonly string[] = [],
): readonly string[] {
  const supported: string[] = ['pause', 'resume', 'cancel', 'emergency_stop']

  // Home is always available if kinematics are configured (toolhead / gcode)
  supported.push('home')
  if (objects.includes('print_stats') && objects.includes('webhooks'))
    supported.push('service')

  // Speed factor (M220) is supported by default in Klipper gcode
  supported.push('set_speed')

  // Temperature control: available if extruder, heater_bed, heater_generic, or temperature_fan is present
  const hasHeaters = objects.some(
    (obj) =>
      obj === 'extruder' ||
      obj.startsWith('extruder') ||
      obj === 'heater_bed' ||
      obj.startsWith('heater_generic ') ||
      obj.startsWith('temperature_fan '),
  )
  if (hasHeaters || objects.length === 0) {
    supported.push('set_temperature')
  }

  // Fan control: M106 for part fan is standard gcode, plus fan_generic objects
  supported.push('set_fan')

  // Light control: available if output_pin caselight or led / neopixel / dotstar / pca9533 / pca9632 is present
  const hasLight = objects.some((obj) => {
    if (obj.startsWith('output_pin ')) {
      const pin = obj.slice('output_pin '.length).trim()
      return pin.toLowerCase() === 'caselight'
    }
    return (
      obj.startsWith('led ') ||
      obj.startsWith('neopixel ') ||
      obj.startsWith('dotstar ') ||
      obj.startsWith('pca9533 ') ||
      obj.startsWith('pca9632 ')
    )
  })
  if (hasLight || objects.length === 0) {
    supported.push('set_light')
  }

  if (objects.includes('virtual_sdcard'))
    supported.push('file_op', 'start_print')
  if (objects.includes('exclude_object') && objects.includes('print_stats'))
    supported.push('exclude_object')
  // Named LEDs and output pins need the object list; an unknown list never widens support.
  if (ledNames(objects).length) supported.push('set_led')
  if (pinNames(objects).length) supported.push('set_pin')
  if (objects.includes('extruder')) supported.push('extrude')
  if (advertisedMoonrakerMacros(objects)?.length) supported.push('run_macro')
  if (objects.includes('gcode_macro LOAD_FILAMENT'))
    supported.push('load_filament')
  if (objects.includes('gcode_macro UNLOAD_FILAMENT'))
    supported.push('unload_filament')
  // The queue is a Moonraker component; detection marks it next to the objects.
  if (objects.includes(POWER_MARKER)) supported.push('power')
  if (objects.includes('configfile') && objects.includes('print_stats'))
    supported.push('config_write')
  if (bedMeshSupported(objects)) supported.push('bed_mesh')
  if (queueSupported(objects)) supported.push('queue_op')
  // Timelapse is a plugin component; detection marks it next to the objects.
  if (timelapseSupported(objects)) supported.push('timelapse')
  // Motion actions are advertised only when the printer lists a toolhead.
  if (motionSupported(objects))
    supported.push('jog', 'motors_off', 'z_babystep', 'set_factor')
  return Object.freeze(supported)
}

/**
 * Build Moonraker JSON-RPC call from extended action, arguments, and printer.objects.list.
 * Never composes G-code from unvalidated strings: whitelists heater/fan/pin names from objects.
 * Building writes nothing, so every failure is a `DriverRefusalError`; one that
 * is not already typed means the arguments were rejected.
 */
export function buildMoonrakerCommand(
  action: string,
  args: Record<string, unknown> = {},
  objects: readonly string[] = [],
): MoonrakerRpcCall {
  try {
    return composeMoonrakerCommand(action, args, objects)
  } catch (error) {
    if (error instanceof DriverRefusalError) throw error
    throw new DriverRefusalError(
      'invalid-command',
      error instanceof Error ? error.message : 'Invalid command',
      { cause: error },
    )
  }
}

/** The printer does not list what the command needs. */
const unavailable = (message: string) =>
  new DriverRefusalError('unsupported-action', message)

function composeMoonrakerCommand(
  action: string,
  args: Record<string, unknown>,
  objects: readonly string[],
): MoonrakerRpcCall {
  const u1 = objects.includes(SNAPMAKER_U1_MARKER)
  if (u1 && !snapmakerU1Controls(objects).some((control) => control === action))
    throw new SnapmakerU1CommandRefused(action)

  if (u1 && action === 'set_tool_temperature') {
    const parsed = ControlArguments.parse({ action, args })
    if (parsed.action !== action) throw new Error('Invalid tool temperature')
    const { tool, target_c } = parsed.args
    const heater = U1_TOOL_OBJECTS[tool]
    if (!objects.includes(heater))
      throw unavailable('U1 tool temperature unavailable')
    if (target_c > U1_MAX_TOOL_C)
      throw new Error('U1 tool temperature unavailable')
    return {
      method: 'printer.gcode.script',
      params: {
        script: `SET_HEATER_TEMPERATURE HEATER=${heater} TARGET=${target_c}`,
      },
    }
  }
  const keys = (allowed: string[]) => {
    for (const key of Object.keys(args)) {
      if (!allowed.includes(key)) {
        throw new Error(`Unexpected argument '${key}' for action '${action}'`)
      }
    }
  }

  if (['run_macro', 'load_filament', 'unload_filament'].includes(action)) {
    keys(action === 'run_macro' ? ['name', 'params'] : [])
    const name =
      action === 'run_macro'
        ? args.name
        : action === 'load_filament'
          ? 'LOAD_FILAMENT'
          : 'UNLOAD_FILAMENT'
    if (
      typeof name !== 'string' ||
      !objects.includes(`gcode_macro ${name}`) ||
      (action === 'run_macro' &&
        !advertisedMoonrakerMacros(objects)?.includes(name))
    )
      throw unavailable('Macro unavailable')
    let script: string
    try {
      script = buildMacroScript(
        name,
        action === 'run_macro' ? args.params : undefined,
      )
    } catch {
      throw new Error('Invalid macro parameters')
    }
    return { method: 'printer.gcode.script', params: { script } }
  }

  if (isMotionAction(action)) {
    // Arguments only; state refusals are decided by the driver before sending.
    return {
      method: 'printer.gcode.script',
      params: { script: buildMotionScript(action, args) },
    }
  }

  if (action === 'bed_mesh') {
    if (!bedMeshSupported(objects))
      throw new BedMeshRefused('unsupported-action')
    return {
      method: 'printer.gcode.script',
      params: { script: bedMeshScript(args) },
    }
  }
  if (action === 'power') return powerCommand(args, objects)
  if (action === 'queue_op') {
    if (!queueSupported(objects)) throw unavailable('Queue unavailable')
    return parseQueueOp(args).call
  }
  if (action === 'gcode') {
    keys(['line'])
    return {
      method: 'printer.gcode.script',
      params: { script: buildConsoleScript(args) },
    }
  }

  if (action === 'extrude') {
    return {
      method: 'printer.gcode.script',
      params: { script: parseExtrude(args, objects).script },
    }
  }

  if (action === 'start_print') {
    const parsed = ControlArguments.parse({ action, args })
    if (parsed.action !== 'start_print' || !objects.includes('virtual_sdcard'))
      throw unavailable('File printing unavailable')
    return {
      method: 'printer.print.start',
      params: { filename: PrinterGcodePath.parse(parsed.args.file) },
    }
  }

  if (action === 'set_led' || action === 'set_pin') {
    return {
      method: 'printer.gcode.script',
      params: {
        script: (action === 'set_led' ? ledScript : pinScript)(args, objects),
      },
    }
  }

  if (action === 'service') {
    if (!supportedMoonrakerActions(objects).includes(action))
      throw unavailable('Service control unavailable')
    return serviceCommand(args)
  }
  if (action === 'timelapse') {
    if (!timelapseSupported(objects)) throw unavailable('Timelapse unavailable')
    return parseTimelapseOp(args).call
  }

  if (action === 'pause') {
    keys([])
    return { method: 'printer.print.pause' }
  }

  if (action === 'resume') {
    keys([])
    return { method: 'printer.print.resume' }
  }

  if (action === 'cancel') {
    keys([])
    return { method: 'printer.print.cancel' }
  }

  if (action === 'emergency_stop') {
    keys([])
    return { method: 'printer.emergency_stop' }
  }

  if (action === 'home') {
    keys(['axes'])
    let script = 'G28'
    if (args.axes !== undefined) {
      if (
        !Array.isArray(args.axes) ||
        !args.axes.length ||
        args.axes.length > 3 ||
        new Set(args.axes).size !== args.axes.length ||
        args.axes.some((axis) => !['x', 'y', 'z'].includes(axis))
      ) {
        throw new Error('Invalid axes')
      }
      const axesUpper = args.axes.map((a: string) => a.toUpperCase())
      script = `G28 ${axesUpper.join(' ')}`
    }
    return {
      method: 'printer.gcode.script',
      params: { script },
    }
  }

  if (action === 'set_speed') {
    keys(['level', 'percent'])
    let speedPercent: number
    if (typeof args.level === 'string') {
      const speedMap: Record<string, number> = {
        silent: 50,
        standard: 100,
        sport: 124,
        ludicrous: 166,
      }
      const mapped = speedMap[args.level]
      if (mapped === undefined) {
        throw new Error(`Invalid speed level '${args.level}'`)
      }
      speedPercent = mapped
    } else if (typeof args.percent === 'number') {
      if (
        !Number.isInteger(args.percent) ||
        args.percent < 10 ||
        args.percent > 500
      ) {
        throw new Error('Invalid speed percent')
      }
      speedPercent = args.percent
    } else {
      throw new Error('Speed requires level string or percent integer')
    }
    return {
      method: 'printer.gcode.script',
      params: { script: `M220 S${speedPercent}` },
    }
  }

  if (action === 'set_temperature') {
    keys(['heater', 'target_c'])
    const heater = args.heater
    const targetC = args.target_c

    if (
      typeof targetC !== 'number' ||
      !Number.isInteger(targetC) ||
      targetC < 0
    ) {
      throw new Error('Invalid temperature value')
    }

    if (heater === 'extruder') {
      if (targetC > 300) {
        throw new Error('Extruder temperature exceeds maximum limit')
      }
      if (u1 && !objects.includes('extruder'))
        throw unavailable("Heater 'extruder' not found in printer objects")
      if (
        objects.length > 0 &&
        !objects.some((obj) => obj === 'extruder' || obj.startsWith('extruder'))
      ) {
        throw unavailable("Heater 'extruder' not found in printer objects")
      }
      return {
        method: 'printer.gcode.script',
        params: {
          script: `SET_HEATER_TEMPERATURE HEATER=extruder TARGET=${targetC}`,
        },
      }
    }

    if (heater === 'bed') {
      if (targetC > (u1 ? U1_MAX_BED_C : 120)) {
        throw new Error('Bed temperature exceeds maximum limit')
      }
      if (objects.length > 0 && !objects.includes('heater_bed')) {
        throw unavailable("Heater 'heater_bed' not found in printer objects")
      }
      return {
        method: 'printer.gcode.script',
        params: {
          script: `SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=${targetC}`,
        },
      }
    }

    if (heater === 'chamber') {
      if (u1) throw new SnapmakerU1CommandRefused(action)
      if (targetC > 65) {
        throw new Error('Chamber temperature exceeds maximum limit')
      }
      const hasHeaterGeneric = objects.includes('heater_generic chamber')
      const hasTempFan = objects.includes('temperature_fan chamber')
      if (objects.length > 0 && !hasHeaterGeneric && !hasTempFan) {
        throw unavailable('Chamber heater not found in printer objects')
      }

      if (hasHeaterGeneric || (!hasTempFan && objects.length === 0)) {
        return {
          method: 'printer.gcode.script',
          params: {
            script: `SET_HEATER_TEMPERATURE HEATER=chamber TARGET=${targetC}`,
          },
        }
      }

      if (hasTempFan) {
        return {
          method: 'printer.gcode.script',
          params: {
            script: `SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN=chamber TARGET=${targetC}`,
          },
        }
      }
    }

    // Custom named heater if present in objects
    if (typeof heater === 'string' && SAFE_IDENTIFIER.test(heater)) {
      const match = objects.find(
        (obj) =>
          obj === `heater_generic ${heater}` ||
          obj === `temperature_fan ${heater}` ||
          obj === heater,
      )
      if (match) {
        if (targetC > 300) {
          throw new Error('Temperature exceeds maximum limit')
        }
        if (match.startsWith('temperature_fan ')) {
          return {
            method: 'printer.gcode.script',
            params: {
              script: `SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN=${heater} TARGET=${targetC}`,
            },
          }
        }
        return {
          method: 'printer.gcode.script',
          params: {
            script: `SET_HEATER_TEMPERATURE HEATER=${heater} TARGET=${targetC}`,
          },
        }
      }
    }

    throw new Error(`Invalid or unconfigured heater '${String(heater)}'`)
  }

  if (action === 'set_fan') {
    keys(['fan', 'percent', 'on'])
    let speed255: number
    if (typeof args.on === 'boolean') {
      speed255 = args.on ? 255 : 0
    } else if (typeof args.percent === 'number') {
      if (
        !Number.isInteger(args.percent) ||
        args.percent < 0 ||
        args.percent > 100
      ) {
        throw new Error('Invalid fan percent value')
      }
      speed255 = Math.round((args.percent * 255) / 100)
    } else {
      throw new Error('Fan state requires on boolean or percent integer')
    }

    const fanType = args.fan
    if (fanType === 'part') {
      return {
        method: 'printer.gcode.script',
        params: { script: `M106 S${speed255}` },
      }
    }

    if (fanType === 'aux' || fanType === 'chamber') {
      const candidates = [
        `fan_generic ${fanType}`,
        `fan_generic ${fanType}_fan`,
      ]
      const found = objects.find((obj) => candidates.includes(obj))
      if (objects.length > 0 && !found)
        throw new OutputRefused('unsupported-action')
      const fanName = found ? found.slice('fan_generic '.length) : fanType
      if (!SAFE_IDENTIFIER.test(fanName)) throw new Error('Unsafe fan name')
      return {
        method: 'printer.gcode.script',
        params: {
          script: `SET_FAN_SPEED FAN=${fanName} SPEED=${formatFanSpeed(speed255)}`,
        },
      }
    }

    if (typeof fanType === 'string' && SAFE_IDENTIFIER.test(fanType)) {
      return {
        method: 'printer.gcode.script',
        params: { script: namedFanScript(fanType, speed255, objects) },
      }
    }

    throw new OutputRefused('invalid-command')
  }

  if (action === 'set_light') {
    keys(['on', 'brightness', 'pin', 'led'])
    let on = true
    if (typeof args.on === 'boolean') {
      on = args.on
    } else if (typeof args.brightness === 'number') {
      if (
        !Number.isInteger(args.brightness) ||
        args.brightness < 0 ||
        args.brightness > 100
      ) {
        throw new Error('Invalid brightness')
      }
      on = args.brightness > 0
    }

    // Check objects for caselight or LED
    const hasCaselight = objects.some((obj) => {
      if (obj.startsWith('output_pin ')) {
        return obj.slice('output_pin '.length).trim() === 'caselight'
      }
      return false
    })
    const ledObj = objects.find(
      (obj) =>
        obj.startsWith('led ') ||
        obj.startsWith('neopixel ') ||
        obj.startsWith('dotstar ') ||
        obj.startsWith('pca9533 ') ||
        obj.startsWith('pca9632 '),
    )

    if (hasCaselight || (!ledObj && objects.length === 0)) {
      const val = on ? 1 : 0
      return {
        method: 'printer.gcode.script',
        params: { script: `SET_PIN PIN=caselight VALUE=${val}` },
      }
    }

    if (ledObj) {
      const ledName = ledObj.split(' ')[1]
      if (!ledName || !SAFE_IDENTIFIER.test(ledName)) {
        throw new Error('Unsafe LED name')
      }
      const val = on ? 1 : 0
      return {
        method: 'printer.gcode.script',
        params: {
          script: `SET_LED LED=${ledName} WHITE=${val} SYNC=0 TRANSMIT=1`,
        },
      }
    }

    throw unavailable(
      'No supported light or caselight found in printer objects',
    )
  }

  throw unavailable(`Unsupported Moonraker action '${action}'`)
}
