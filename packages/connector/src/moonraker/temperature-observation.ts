import { z } from 'zod'

const Sensor = z.object({ temperature: z.unknown().optional() }).passthrough()
const Status = z.object({
  extruder: z.unknown().optional(),
  heater_bed: z.unknown().optional(),
}).passthrough()

type TemperatureField =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'reading'; celsius: number }
export type TemperatureFields = { tool: TemperatureField; bed: TemperatureField }

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
  return { tool: field(parsed.data.extruder), bed: field(parsed.data.heater_bed) }
}
