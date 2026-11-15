/**
 * Creality stock-firmware LAN WebSocket (port 9999) command module.
 *
 * Public sources:
 * - https://github.com/OrcaSlicer/OrcaSlicer/blob/main/src/slic3r/Utils/CrealityPrint.cpp
 *   (Creality Print / OrcaSlicer native LAN WebSocket transport & command serialization).
 * - https://github.com/ChestnutLabs/printer-protocol-orchard/blob/main/protocols/creality.md
 *   (LAN WebSocket :9999 protocol documentation for stock K1/K1 Max/K1C/K2/Hi Creality OS:
 *    envelope format {"method":"set","params":{...}}, pause:1, pause:0, stop:1,
 *    nozzleTempControl, bedTempControl, boxTempControl, fan, fanAuxiliary, fanCase,
 *    lightSw, autohome).
 */

export const CREALITY_ACTIONS = [
  'pause',
  'resume',
  'cancel',
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'start_print',
] as const

export type CrealityAction = (typeof CREALITY_ACTIONS)[number]

export function supportedCrealityActions(_model?: string): readonly string[] {
  return [...CREALITY_ACTIONS]
}

export interface CrealitySetFrame {
  method: 'set'
  params: Record<string, unknown>
}

/**
 * Builds WebSocket 9999 'set' frames for supported Creality stock actions.
 * Throws on unsupported actions or invalid argument shapes.
 */
export function buildCrealityCommand(
  action: string,
  args: Record<string, unknown> = {},
): CrealitySetFrame {
  const keys = (allowed: string[]) => {
    for (const key of Object.keys(args)) {
      if (!allowed.includes(key)) {
        throw new Error(`Unexpected argument '${key}' for action '${action}'`)
      }
    }
  }

  if (action === 'start_print') {
    keys(['file'])
    if (
      typeof args.file !== 'string' ||
      !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,254}\.gcode$/i.test(args.file) ||
      args.file.includes('..') ||
      Buffer.byteLength(args.file) > 255
    )
      throw new Error('Invalid Creality filename')
    return {
      method: 'set',
      params: {
        opGcodeFile: `printprt:/usr/data/printer_data/gcodes/${args.file}`,
      },
    }
  }

  if (action === 'pause') {
    keys([])
    return {
      method: 'set',
      params: { pause: 1 },
    }
  }

  if (action === 'resume') {
    keys([])
    return {
      method: 'set',
      params: { pause: 0 },
    }
  }

  if (action === 'cancel') {
    keys([])
    return {
      method: 'set',
      params: { stop: 1 },
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
      return {
        method: 'set',
        params: { nozzleTempControl: targetC },
      }
    }

    if (heater === 'bed') {
      if (targetC > 120) {
        throw new Error('Bed temperature exceeds maximum limit')
      }
      return {
        method: 'set',
        params: { bedTempControl: { num: 0, val: targetC } },
      }
    }

    if (heater === 'chamber') {
      if (targetC > 65) {
        throw new Error('Chamber temperature exceeds maximum limit')
      }
      return {
        method: 'set',
        params: { boxTempControl: targetC },
      }
    }

    throw new Error('Invalid heater type')
  }

  if (action === 'set_fan') {
    keys(['fan', 'percent', 'on'])
    let on: number | undefined
    if (typeof args.on === 'boolean') {
      on = args.on ? 1 : 0
    } else if (typeof args.percent === 'number') {
      if (
        !Number.isInteger(args.percent) ||
        args.percent < 0 ||
        args.percent > 100
      ) {
        throw new Error('Invalid fan percent value')
      }
      on = args.percent > 0 ? 1 : 0
    } else {
      throw new Error('Fan state requires on boolean or percent integer')
    }

    const fanType = args.fan
    if (fanType === 'part') {
      return {
        method: 'set',
        params: { fan: on },
      }
    }

    if (fanType === 'aux') {
      return {
        method: 'set',
        params: { fanAuxiliary: on },
      }
    }

    if (fanType === 'chamber') {
      return {
        method: 'set',
        params: { fanCase: on },
      }
    }

    throw new Error('Invalid fan type')
  }

  if (action === 'set_light') {
    keys(['on'])
    if (typeof args.on !== 'boolean') {
      throw new Error('Light state requires boolean on argument')
    }
    return {
      method: 'set',
      params: { lightSw: args.on ? 1 : 0 },
    }
  }

  if (action === 'home') {
    keys(['axes'])
    if (
      !Array.isArray(args.axes) ||
      !args.axes.length ||
      new Set(args.axes).size !== args.axes.length ||
      args.axes.some((axis) => !['x', 'y', 'z'].includes(axis))
    ) {
      throw new Error('Invalid axes')
    }

    const hasX = args.axes.includes('x')
    const hasY = args.axes.includes('y')
    const hasZ = args.axes.includes('z')

    let axisStr = ''
    if (hasX && hasY && hasZ) {
      axisStr = 'X Y Z'
    } else if (hasX && hasY) {
      axisStr = 'X Y'
    } else if (hasX) {
      axisStr = 'X'
    } else if (hasY) {
      axisStr = 'Y'
    } else if (hasZ) {
      axisStr = 'Z'
    }

    return {
      method: 'set',
      params: { autohome: axisStr },
    }
  }

  throw new Error(`Unsupported Creality action '${action}'`)
}
