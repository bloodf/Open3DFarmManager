import type { PrinterState } from '@open3dfarmmanager/farm-protocol'

type MachineProfile = NonNullable<PrinterState['machine']>

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function positive(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function label(value: unknown) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length && trimmed.length <= 64 ? trimmed : undefined
}

export function reportedModelProfile(
  value: unknown,
): MachineProfile | undefined {
  const model = label(value)
  return model ? { model } : undefined
}

export function moonrakerMachineProfile(
  configfile: unknown,
): MachineProfile | undefined {
  const settings = object(object(configfile).settings)
  const nozzleDiameterMm: Record<string, number> = {}
  const maxHotendTemperatureCelsius: Record<string, number> = {}
  let tools = 0
  let consecutive = true
  for (let tool = 0; tool < 17; tool++) {
    const section = settings[tool === 0 ? 'extruder' : `extruder${tool}`]
    if (!section || typeof section !== 'object' || Array.isArray(section))
      continue
    if (tool !== tools) consecutive = false
    tools++
    const extruder = object(section)
    const nozzle = positive(extruder.nozzle_diameter)
    const maxTemp = positive(extruder.max_temp)
    if (nozzle !== undefined) nozzleDiameterMm[tool] = nozzle
    if (maxTemp !== undefined) maxHotendTemperatureCelsius[tool] = maxTemp
  }
  const bedSizeMm: NonNullable<MachineProfile['bedSizeMm']> = {}
  for (const axis of ['x', 'y', 'z'] as const) {
    const stepper = object(settings[`stepper_${axis}`])
    const size = positive(stepper.position_max)
    if (size !== undefined) bedSizeMm[axis] = size
  }
  const maxBedTemperatureCelsius = positive(
    object(settings.heater_bed).max_temp,
  )
  const kinematics = label(object(settings.printer).kinematics)
  const profile: MachineProfile = {
    ...(tools &&
    consecutive &&
    !Object.keys(settings).some(
      (name) => /^extruder\d+$/.test(name) && Number(name.slice(8)) >= 17,
    )
      ? { toolCount: tools }
      : {}),
    ...(Object.keys(nozzleDiameterMm).length ? { nozzleDiameterMm } : {}),
    ...(Object.keys(bedSizeMm).length ? { bedSizeMm } : {}),
    ...(Object.keys(maxHotendTemperatureCelsius).length
      ? { maxHotendTemperatureCelsius }
      : {}),
    ...(maxBedTemperatureCelsius !== undefined
      ? { maxBedTemperatureCelsius }
      : {}),
    ...(kinematics ? { kinematics } : {}),
  }
  return Object.keys(profile).length ? profile : undefined
}

export function bambuMachineProfile(
  report: unknown,
): MachineProfile | undefined {
  const print = object(object(report).print)
  const model = label(print.printer_type)
  const rawDiameter = print.nozzle_diameter
  const diameter = positive(
    typeof rawDiameter === 'string' && /^\d+(?:\.\d+)?$/.test(rawDiameter)
      ? Number(rawDiameter)
      : rawDiameter,
  )
  if (!model && diameter === undefined) return undefined
  return {
    ...(model ? { model } : {}),
    ...(diameter === undefined ? {} : { nozzleDiameterMm: { 0: diameter } }),
  }
}
