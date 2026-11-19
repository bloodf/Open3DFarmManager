import {
  GCODE_HEAD_BYTES,
  GCODE_TAIL_BYTES,
  type GcodeByteSource,
} from './gcode-meta.ts'
import { readLibraryGcodeMetadata, type PrintFileMetadata } from './metadata.ts'
import {
  bufferSource,
  ZipArchive,
  ZipError,
  type ZipErrorCode,
  type ZipLimits,
  type ZipSource,
} from './zip.ts'

const MODEL_ENTRY = '3D/3dmodel.model'
const SLICE_INFO = 'Metadata/slice_info.config'
const PROJECT_SETTINGS = 'Metadata/project_settings.config'
const CONFIG_MAX_BYTES = 8 * 1024 * 1024
const THUMBNAIL_MAX_BYTES = 512 * 1024
const GCODE_HEAD = GCODE_HEAD_BYTES
const GCODE_TAIL = GCODE_TAIL_BYTES
const MAX_PLATES = 256
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const UNSLICED_REASON =
  'Projeto sem G-code de placa: fatie no slicer e exporte novamente para poder iniciar a impressão.'

export interface ThreeMfFilament {
  id: number
  type?: string
  colour?: string
  usedMeters?: number
  usedGrams?: number
}

export interface ThreeMfObject {
  name: string
  skipped: boolean
}

export interface ThreeMfPlate {
  /** 1-based plate number as written by the slicer. */
  index: number
  /** True only when the plate carries G-code. */
  startable: boolean
  gcodePath?: string
  thumbnail?: { mimeType: 'image/png'; data: string }
  estimatedTimeSeconds?: number
  weightGrams?: number
  nozzleDiameter?: number
  printerModelId?: string
  filaments: ThreeMfFilament[]
  objects: ThreeMfObject[]
  /** Header and footer fields parsed from the plate G-code by the E17.2 parser. */
  gcode?: PrintFileMetadata
}

export interface ThreeMfProject {
  /** True when at least one plate has G-code. */
  sliced: boolean
  startable: boolean
  /** pt-BR reason shown when the project cannot be started. */
  unstartableReason?: string
  slicer?: string
  slicerVersion?: string
  printerModel?: string
  printerProfile?: string
  nozzleDiameter?: number
  /** Project-wide filament slots from project_settings.config. */
  filaments: ThreeMfFilament[]
  plates: ThreeMfPlate[]
}

export type ThreeMfResult =
  | { ok: true; project: ThreeMfProject }
  | { ok: false; code: ZipErrorCode | 'not-3mf'; reason: string }

/** Reads a .3mf project without inflating anything beyond the configured zip limits. */
export async function readThreeMf(
  input: Uint8Array | ZipSource,
  limits: Partial<ZipLimits> = {},
): Promise<ThreeMfResult> {
  try {
    const zip = await ZipArchive.open(
      input instanceof Uint8Array ? bufferSource(input) : input,
      limits,
    )
    if (!zip.has(MODEL_ENTRY))
      return {
        ok: false,
        code: 'not-3mf',
        reason: 'O arquivo não é um projeto 3MF: falta 3D/3dmodel.model.',
      }
    return { ok: true, project: await readProject(zip) }
  } catch (error) {
    if (error instanceof ZipError)
      return { ok: false, code: error.code, reason: error.message }
    throw error
  }
}

async function readProject(zip: ZipArchive): Promise<ThreeMfProject> {
  const sliceInfo = zip.has(SLICE_INFO)
    ? parseSliceInfo(decode(await zip.read(SLICE_INFO, CONFIG_MAX_BYTES)))
    : { header: new Map<string, string>(), plates: [] }
  const settings = zip.has(PROJECT_SETTINGS)
    ? parseSettings(decode(await zip.read(PROJECT_SETTINGS, CONFIG_MAX_BYTES)))
    : {}
  const gcodeByIndex = new Map<number, string>()
  for (const entry of zip.entries) {
    const match = /^Metadata\/plate_(\d{1,6})\.gcode$/i.exec(entry.name)
    if (match && !entry.directory)
      gcodeByIndex.set(Number(match[1]), entry.name)
  }
  const declared = new Map(
    sliceInfo.plates.map((plate) => [plate.index, plate]),
  )
  const indexes = [...new Set([...declared.keys(), ...gcodeByIndex.keys()])]
    .sort((a, b) => a - b)
    .slice(0, MAX_PLATES)
  const projectFilaments = settingsFilaments(settings)
  const plates: ThreeMfPlate[] = []
  for (const index of indexes) {
    const base = declared.get(index)
    const gcodePath = gcodeByIndex.get(index)
    const plate: ThreeMfPlate = {
      index,
      startable: gcodePath !== undefined,
      filaments: (base?.filaments ?? []).map((filament) => ({
        ...projectFilaments[filament.id - 1],
        ...filament,
      })),
      objects: base?.objects ?? [],
      ...(base?.estimatedTimeSeconds !== undefined && {
        estimatedTimeSeconds: base.estimatedTimeSeconds,
      }),
      ...(base?.weightGrams !== undefined && { weightGrams: base.weightGrams }),
      ...(base?.nozzleDiameter !== undefined && {
        nozzleDiameter: base.nozzleDiameter,
      }),
      ...(base?.printerModelId !== undefined && {
        printerModelId: base.printerModelId,
      }),
    }
    const thumbnail = await readThumbnail(zip, index)
    if (thumbnail) plate.thumbnail = thumbnail
    if (gcodePath) {
      plate.gcodePath = gcodePath
      plate.gcode = await readLibraryGcodeMetadata(
        await windowedSource(zip, gcodePath),
      )
    }
    plates.push(plate)
  }
  const sliced = plates.some((plate) => plate.startable)
  const slicer = sliceInfo.header.get('X-BBL-Client-Type')
  const version = sliceInfo.header.get('X-BBL-Client-Version')
  return {
    sliced,
    startable: sliced,
    ...(!sliced && { unstartableReason: UNSLICED_REASON }),
    ...(slicer && { slicer: slicer === 'slicer' ? 'Bambu Studio' : slicer }),
    ...(version && { slicerVersion: version }),
    ...(settings.printerModel && { printerModel: settings.printerModel }),
    ...(settings.printerProfile && { printerProfile: settings.printerProfile }),
    ...(settings.nozzleDiameter !== undefined && {
      nozzleDiameter: settings.nozzleDiameter,
    }),
    filaments: projectFilaments,
    plates,
  }
}

async function readThumbnail(
  zip: ZipArchive,
  index: number,
): Promise<ThreeMfPlate['thumbnail']> {
  const name = `Metadata/plate_${index}.png`
  const entry = zip.get(name)
  if (!entry || entry.directory || entry.uncompressedSize > THUMBNAIL_MAX_BYTES)
    return undefined
  const data = await zip.read(name, THUMBNAIL_MAX_BYTES)
  if (!PNG_MAGIC.every((byte, i) => data[i] === byte)) return undefined
  return { mimeType: 'image/png', data: Buffer.from(data).toString('base64') }
}

/** Presents a bounded scan of a plate G-code entry as the random-access source the E17.2 parser expects. */
async function windowedSource(
  zip: ZipArchive,
  name: string,
): Promise<GcodeByteSource> {
  const { size, head, tail } = await zip.scan(name, GCODE_HEAD, GCODE_TAIL)
  const tailStart = size - tail.length
  return {
    size,
    async read(offset, length) {
      const end = Math.min(size, offset + length)
      if (end <= head.length) return head.subarray(offset, end)
      if (offset >= tailStart)
        return tail.subarray(offset - tailStart, end - tailStart)
      return new Uint8Array()
    },
  }
}

interface SliceInfoPlate extends Omit<
  ThreeMfPlate,
  'startable' | 'gcodePath' | 'thumbnail' | 'gcode'
> {}

function parseSliceInfo(xml: string): {
  header: Map<string, string>
  plates: SliceInfoPlate[]
} {
  const header = new Map<string, string>()
  for (const match of xml.matchAll(/<header_item\b([^>]*)>/g)) {
    const attrs = attributes(match[1] ?? '')
    const key = attrs.get('key')
    const value = attrs.get('value')
    if (key && value) header.set(key, value)
  }
  const plates: SliceInfoPlate[] = []
  for (const block of xml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)) {
    const body = block[1] ?? ''
    const meta = new Map<string, string>()
    for (const match of body.matchAll(/<metadata\b([^>]*)>/g)) {
      const attrs = attributes(match[1] ?? '')
      const key = attrs.get('key')
      if (key) meta.set(key, attrs.get('value') ?? '')
    }
    const index = integer(meta.get('index'))
    if (index === undefined || index < 1 || plates.length >= MAX_PLATES)
      continue
    const filaments: ThreeMfFilament[] = []
    for (const match of body.matchAll(/<filament\b([^>]*)>/g)) {
      const attrs = attributes(match[1] ?? '')
      const id = integer(attrs.get('id'))
      if (id === undefined || id < 1) continue
      const filament: ThreeMfFilament = { id }
      const type = attrs.get('type')
      const colour = attrs.get('color')
      const meters = number(attrs.get('used_m'))
      const grams = number(attrs.get('used_g'))
      if (type) filament.type = type
      if (colour) filament.colour = colour
      if (meters !== undefined) filament.usedMeters = meters
      if (grams !== undefined) filament.usedGrams = grams
      filaments.push(filament)
    }
    const objects: ThreeMfObject[] = []
    for (const match of body.matchAll(/<object\b([^>]*)>/g)) {
      const attrs = attributes(match[1] ?? '')
      const name = attrs.get('name')
      if (name) objects.push({ name, skipped: attrs.get('skipped') === 'true' })
    }
    const plate: SliceInfoPlate = { index, filaments, objects }
    const prediction = number(meta.get('prediction'))
    const weight = number(meta.get('weight'))
    const nozzle = number(meta.get('nozzle_diameters')?.split(/[;,]/)[0])
    const model = meta.get('printer_model_id')
    if (prediction !== undefined && prediction >= 0)
      plate.estimatedTimeSeconds = prediction
    if (weight !== undefined && weight >= 0) plate.weightGrams = weight
    if (nozzle !== undefined && nozzle > 0) plate.nozzleDiameter = nozzle
    if (model) plate.printerModelId = model
    plates.push(plate)
  }
  return { header, plates }
}

interface ProjectSettings {
  printerModel?: string
  printerProfile?: string
  nozzleDiameter?: number
  filamentTypes?: string[]
  filamentColours?: string[]
}

function parseSettings(text: string): ProjectSettings {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value)
  const text1 = (value: unknown) =>
    typeof first(value) === 'string' && first(value) !== ''
      ? (first(value) as string)
      : undefined
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value.slice(0, 64).map((item) => (typeof item === 'string' ? item : ''))
      : undefined
  const settings: ProjectSettings = {}
  const model = text1(record['printer_model'])
  const profile = text1(record['printer_settings_id'])
  const nozzle = number(text1(record['nozzle_diameter']))
  const types = list(record['filament_type'])
  const colours = list(record['filament_colour'])
  if (model) settings.printerModel = model
  if (profile) settings.printerProfile = profile
  if (nozzle !== undefined && nozzle > 0) settings.nozzleDiameter = nozzle
  if (types) settings.filamentTypes = types
  if (colours) settings.filamentColours = colours
  return settings
}

function settingsFilaments(settings: ProjectSettings): ThreeMfFilament[] {
  const count = Math.max(
    settings.filamentTypes?.length ?? 0,
    settings.filamentColours?.length ?? 0,
  )
  return Array.from({ length: count }, (_, i): ThreeMfFilament => {
    const type = settings.filamentTypes?.[i]
    const colour = settings.filamentColours?.[i]
    return { id: i + 1, ...(type && { type }), ...(colour && { colour }) }
  })
}

function attributes(source: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of source.matchAll(
    /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    map.set(match[1]!, unescapeXml(match[2] ?? match[3] ?? ''))
  }
  return map
}

function unescapeXml(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, entity: string) => {
      const lower = entity.toLowerCase()
      if (lower === 'amp') return '&'
      if (lower === 'lt') return '<'
      if (lower === 'gt') return '>'
      if (lower === 'quot') return '"'
      if (lower === 'apos') return "'"
      const code = lower.startsWith('#x')
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10)
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : ''
    },
  )
}

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

function number(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*-?\d+(?:\.\d+)?\s*$/.test(value))
    return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function integer(value: string | undefined): number | undefined {
  const n = number(value)
  return n !== undefined && Number.isInteger(n) ? n : undefined
}
