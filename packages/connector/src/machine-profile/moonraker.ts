import {
  MACHINE_PROFILE_MAX_TOOLS,
  MachineProfile,
} from '../../../farm-protocol/src/machine-profile.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A finite number, or a plain decimal string. Anything else is unknown. */
function number(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && /^-?\d{1,9}(?:\.\d{1,9})?$/.test(value))
    return Number(value)
  return undefined
}

function positive(value: unknown, max: number): number | undefined {
  const parsed = number(value)
  return parsed !== undefined && parsed > 0 && parsed <= max
    ? parsed
    : undefined
}

/** `extruder`, `extruder1`, ... in tool order. */
function extruderSections(settings: Record<string, unknown>) {
  const found: { tool: number; section: Record<string, unknown> }[] = []
  for (const [name, value] of Object.entries(settings)) {
    const match = /^extruder(\d*)$/.exec(name)
    const section = record(value)
    if (match && section)
      found.push({ tool: match[1] === '' ? 0 : Number(match[1]), section })
  }
  return found.sort((a, b) => a.tool - b.tool)
}

/** Usable axis length: `position_max`, less a positive `position_min` offset. */
function axisLength(settings: Record<string, unknown>, stepper: string) {
  const section = record(settings[stepper])
  const max = number(section?.position_max)
  if (max === undefined) return undefined
  const min = number(section?.position_min) ?? 0
  return positive(max - Math.max(min, 0), 10_000)
}

/**
 * Maps Klipper `configfile.settings` to a machine profile. Anything missing or
 * malformed is left out; nothing is defaulted. Delta machines have no
 * `stepper_x/y/z`, so their bed size stays unknown.
 */
export function parseMoonrakerMachineProfile(
  settings: unknown,
): MachineProfile | undefined {
  const root = record(settings)
  if (!root) return undefined
  const profile: Record<string, unknown> = {}
  const extruders = extruderSections(root)
  if (extruders.length >= 1 && extruders.length <= MACHINE_PROFILE_MAX_TOOLS) {
    profile.toolCount = extruders.length
    const nozzles = extruders.map((e) =>
      positive(e.section.nozzle_diameter, 10),
    )
    if (nozzles.every((value) => value !== undefined))
      profile.nozzleDiametersMm = nozzles
    const limits = extruders.map((e) => positive(e.section.max_temp, 1_000))
    if (limits.every((value) => value !== undefined))
      // The hottest temperature every tool can reach.
      profile.maxHotendCelsius = Math.min(...(limits as number[]))
  }
  const x = axisLength(root, 'stepper_x')
  const y = axisLength(root, 'stepper_y')
  const z = axisLength(root, 'stepper_z')
  if (x !== undefined && y !== undefined && z !== undefined)
    profile.bedSizeMm = { x, y, z }
  const maxBed = positive(record(root.heater_bed)?.max_temp, 1_000)
  if (maxBed !== undefined) profile.maxBedCelsius = maxBed
  const kinematics = record(root.printer)?.kinematics
  if (typeof kinematics === 'string' && /^[a-z0-9_]{1,32}$/.test(kinematics))
    profile.kinematics = kinematics
  const parsed = MachineProfile.safeParse(profile)
  return parsed.success ? parsed.data : undefined
}

/** Reads `configfile.settings` through a Moonraker `printer.objects.query` result. */
export async function readMoonrakerMachineProfile(client: {
  request(method: string, params: object): Promise<unknown>
}): Promise<MachineProfile | undefined> {
  const result = record(
    await client.request('printer.objects.query', {
      objects: { configfile: ['settings'] },
    }),
  )
  return parseMoonrakerMachineProfile(
    record(record(result?.status)?.configfile)?.settings,
  )
}
