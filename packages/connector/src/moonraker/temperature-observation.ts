import { z } from 'zod'

const Sensor = z.object({ temperature: z.unknown().optional() }).passthrough()
const Status = z
  .object({
    extruder: z.unknown().optional(),
    heater_bed: z.unknown().optional(),
  })
  .passthrough()

type TemperatureField =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'reading'; celsius: number }
export type TemperatureFields = {
  tool: TemperatureField
  bed: TemperatureField
}

function field(sensor: unknown): TemperatureField {
  if (sensor === undefined) return { kind: 'absent' }
  const parsed = Sensor.safeParse(sensor)
  if (!parsed.success) return { kind: 'invalid' }
  if (!Object.hasOwn(parsed.data, 'temperature')) return { kind: 'absent' }
  const temperature = parsed.data.temperature
  return typeof temperature === 'number' && Number.isFinite(temperature)
    ? { kind: 'reading', celsius: temperature }
    : { kind: 'invalid' }
}

export function parseTemperatureFields(status: unknown): TemperatureFields {
  const parsed = Status.safeParse(status)
  if (!parsed.success) throw new TypeError('Invalid Moonraker status')
  return {
    tool: field(parsed.data.extruder),
    bed: field(parsed.data.heater_bed),
  }
}

export function isChamberTemperatureObject(name: string) {
  return (
    name === 'heater_generic chamber' || name === 'temperature_sensor chamber'
  )
}

export function observedTemperatureDetails(status: Record<string, unknown>) {
  function reading(object: unknown, key: string) {
    if (typeof object !== 'object' || object === null || !(key in object))
      return undefined
    const value = (object as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined
  }
  const tools = new Map<number, number>()
  const primaryTarget = reading(status.extruder, 'target')
  if (primaryTarget !== undefined) tools.set(0, primaryTarget)
  for (const [name, object] of Object.entries(status)) {
    const tool = /^extruder([1-9][0-9]{0,2})$/.exec(name)
    const target = tool ? reading(object, 'target') : undefined
    if (tool && target !== undefined) tools.set(Number(tool[1]), target)
  }
  const heater = status['heater_generic chamber']
  const chamberTemperatureCelsius =
    reading(status['temperature_sensor chamber'], 'temperature') ??
    reading(heater, 'temperature')
  const chamberTargetCelsius = reading(heater, 'target')
  return {
    ...(tools.size
      ? {
          toolTargetsCelsius: Array.from(tools)
            .sort(([a], [b]) => a - b)
            .slice(0, 32)
            .map(([tool, target]) => ({ tool, target })),
        }
      : {}),
    ...(chamberTemperatureCelsius === undefined
      ? {}
      : { chamberTemperatureCelsius }),
    ...(chamberTargetCelsius === undefined ? {} : { chamberTargetCelsius }),
  }
}
