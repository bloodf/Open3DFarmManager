import { z } from 'zod'
import { moonrakerTemperature, selectActiveTool } from './discovery-parse.ts'

const Sensor = z.object({ temperature: z.unknown().optional() }).passthrough()
const Status = z.record(z.string(), z.unknown())

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
  const boundedTemperature = moonrakerTemperature.safeParse(temperature)
  return boundedTemperature.success
    ? { kind: 'reading', celsius: boundedTemperature.data }
    : { kind: 'invalid' }
}

export function parseTemperatureFields(
  status: unknown,
  activeToolQuery = false,
): TemperatureFields {
  const parsed = Status.safeParse(status)
  if (!parsed.success) throw new TypeError('Invalid Moonraker status')
  const bed = field(parsed.data.heater_bed)
  if (!activeToolQuery) return { tool: field(parsed.data.extruder), bed }

  const activeTool = selectActiveTool(parsed.data)
  return {
    tool: activeTool ? field(parsed.data[activeTool]) : { kind: 'invalid' },
    bed,
  }
}
