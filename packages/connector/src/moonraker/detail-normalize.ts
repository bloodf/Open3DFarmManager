export type Fields = Record<string, unknown>

export const fields = (value: unknown): Fields =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Fields)
    : {}
export const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : []
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0
export const count = (value: unknown) =>
  Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(number(value))))
export const fraction = (value: unknown) =>
  Math.max(0, Math.min(1, number(value)))
export const string = (value: unknown, max = 128) =>
  typeof value === 'string'
    ? value.slice(0, max).replace(/[\uD800-\uDFFF]/gu, '�')
    : ''

const MAX_NAMED = 64
const fixedObjects = new Set([
  'toolhead',
  'gcode_move',
  'print_stats',
  'virtual_sdcard',
  'display_status',
  'exclude_object',
  'bed_mesh',
  'idle_timeout',
  'webhooks',
])
const heater =
  /^(?:extruder\d*|heater_bed|heater_generic .|temperature_sensor .)/
const fan =
  /^(?:fan$|(?:controller_fan|heater_fan|fan_generic|temperature_fan) .)/
const light = /^(?:led|neopixel|dotstar|pca9533|pca9632) ./
const output = /^(?:output_pin|pwm_tool) ./
const named = [heater, fan, light, output]

/** The detail object set: only what the E18.2 update frame can carry. */
export function selectDetailObjects(objects: unknown): string[] {
  return list(objects).filter(
    (name): name is string =>
      typeof name === 'string' &&
      (fixedObjects.has(name) || named.some((pattern) => pattern.test(name))),
  )
}

/** Drop a name prefix such as `heater_generic ` so the label stays readable. */
const label = (name: string) =>
  string(name.includes(' ') ? name.slice(name.indexOf(' ') + 1) : name)

/** Normalise the merged Moonraker status into the E18.2 update body. */
export function normalizeDetail(status: ReadonlyMap<string, Fields>) {
  const detail: Record<string, unknown> = {}
  const capabilities = new Set<string>(['console', 'files'])
  const add = (key: string, capability: string, value: Fields) => {
    capabilities.add(capability)
    const entries = (detail[key] ??= []) as Fields[]
    if (entries.length < MAX_NAMED) entries.push(value)
  }
  for (const [name, value] of status) {
    if (heater.test(name))
      add('heaters', 'heaters', {
        name: label(name),
        temperature: number(value.temperature),
        target: number(value.target),
        power: fraction(value.power),
      })
    else if (fan.test(name))
      add('fans', 'fans', {
        name: label(name),
        speed: fraction(value.speed),
        ...(typeof value.rpm === 'number' ? { rpm: count(value.rpm) } : {}),
      })
    else if (light.test(name)) {
      const [red, green, blue, white] = list(list(value.color_data)[0])
      if ([red, green, blue].every((item) => typeof item === 'number'))
        add('lights', 'lights', {
          name: label(name),
          red: fraction(red),
          green: fraction(green),
          blue: fraction(blue),
          ...(typeof white === 'number' ? { white: fraction(white) } : {}),
        })
    } else if (output.test(name))
      add('outputs', 'outputs', {
        name: label(name),
        value: number(value.value),
      })
    else normalizeFixed(name, value, detail, capabilities)
  }
  return { detail, capabilities: [...capabilities] }
}

function normalizeFixed(
  name: string,
  value: Fields,
  detail: Record<string, unknown>,
  capabilities: Set<string>,
) {
  switch (name) {
    case 'toolhead': {
      const position = list(value.position).slice(0, 4).map(number)
      if (position.length !== 4) break
      capabilities.add('motion')
      detail.toolhead = {
        position,
        homedAxes: ['x', 'y', 'z'].filter((axis) =>
          string(value.homed_axes).includes(axis),
        ),
      }
      break
    }
    case 'gcode_move': {
      if (typeof value.speed_factor === 'number') {
        capabilities.add('speed')
        detail.speedFactor = Math.max(0, value.speed_factor)
      }
      if (typeof value.extrude_factor === 'number') {
        capabilities.add('flow')
        detail.flowFactor = Math.max(0, value.extrude_factor)
      }
      const origin = list(value.homing_origin)
      if (origin.length >= 3) {
        capabilities.add('offsets')
        detail.offsets = origin.slice(0, 3).map(number)
      }
      break
    }
    case 'print_stats': {
      const info = fields(value.info)
      capabilities.add('job')
      detail.print = {
        ...(string(value.filename, 512)
          ? { file: string(value.filename, 512) }
          : {}),
        state: string(value.state) || 'unknown',
        message: string(value.message, 2048),
        ...(typeof value.filament_used === 'number'
          ? { filamentUsedMm: Math.max(0, number(value.filament_used)) }
          : {}),
        ...(number(value.estimated_time) > 0
          ? { estimatedSeconds: value.estimated_time }
          : {}),
        ...(number(value.filament_total) > 0
          ? { filamentTotalMm: value.filament_total }
          : {}),
        elapsedSeconds: Math.max(0, number(value.print_duration)),
        ...(typeof info.current_layer === 'number'
          ? { currentLayer: count(info.current_layer) }
          : {}),
        ...(typeof info.total_layer === 'number'
          ? { totalLayers: count(info.total_layer) }
          : {}),
      }
      break
    }
    case 'virtual_sdcard':
      detail.virtualFile = {
        active: value.is_active === true,
        progress: fraction(value.progress),
        position: count(value.file_position),
        size: count(value.file_size),
      }
      break
    case 'display_status':
      detail.display = {
        message: string(value.message, 2048),
        progress: fraction(value.progress),
      }
      break
    case 'exclude_object':
      capabilities.add('exclude-object')
      detail.objects = {
        polygons: list(value.objects)
          .slice(0, 64)
          .flatMap((item) => {
            const object = fields(item)
            const name = string(object.name)
            const polygon = list(object.polygon)
            if (!name || polygon.length < 3 || polygon.length > 64) return []
            const points = polygon.map(list)
            if (
              !points.every(
                (point) =>
                  point.length === 2 &&
                  point.every(
                    (coordinate) =>
                      typeof coordinate === 'number' &&
                      Number.isFinite(coordinate) &&
                      Math.abs(coordinate) <= 100_000,
                  ),
              )
            )
              return []
            return [{ name, points }]
          }),
        names: list(value.objects)
          .map((item) => string(fields(item).name))
          .filter(Boolean)
          .slice(0, 256),
        excluded: list(value.excluded_objects)
          .map((item) => string(item))
          .filter(Boolean)
          .slice(0, 256),
        current: string(value.current_object) || null,
      }
      break
    case 'bed_mesh': {
      capabilities.add('bed-mesh')
      const rows = list(value.mesh_matrix)
        .slice(0, 64)
        .map((row) => list(row).slice(0, 64).map(number))
      const min = list(value.mesh_min).slice(0, 2).map(number)
      const max = list(value.mesh_max).slice(0, 2).map(number)
      const probed = list(value.probed_matrix)
        .slice(0, 64)
        .map((row) => list(row).slice(0, 64).map(number))
      const profiles = Object.keys(fields(value.profiles))
        .map((key) => string(key))
        .filter(Boolean)
        .slice(0, 64)
      const width = rows[0]?.length
      if (
        min.length === 2 &&
        max.length === 2 &&
        (rows.length === 0 ||
          (width && rows.every((row) => row.length === width)))
      )
        detail.bedMesh = {
          profile: string(value.profile_name) || null,
          min,
          max,
          rows,
          ...(probed[0]?.length &&
          probed.every((row) => row.length === probed[0]?.length)
            ? { probed }
            : {}),
          ...(profiles.length ? { profiles } : {}),
        }
      break
    }
    case 'idle_timeout':
      detail.idle = {
        state: string(value.state) || 'unknown',
        printingSeconds: Math.max(0, number(value.printing_time)),
      }
      break
    case 'webhooks':
      detail.firmware = {
        state: string(value.state) || 'unknown',
        message: string(value.state_message, 2048),
      }
      break
  }
}
