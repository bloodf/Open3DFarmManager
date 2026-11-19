import {
  MAX_TEXT,
  MAX_THUMBNAIL_BASE64_CHARS,
  MAX_THUMBNAIL_BYTES,
  MAX_TOOLS,
  PrintFileMetadata,
  type PrintFileThumbnail,
  type PrintFileTool,
} from './schema.ts'

/** Bytes read from the start of a file. */
export const GCODE_HEAD_BYTES = 256 * 1024
/** Bytes read from the end of a file. */
export const GCODE_TAIL_BYTES = 256 * 1024

const MAX_LINE = 64 * 1024
const MAX_SET = 4096

/** Random-access byte source; lets the parser stay free of node:fs. */
export interface GcodeByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export function emptyPrintFileMetadata(): PrintFileMetadata {
  return { tools: [] }
}

/** Reads only the header and the last 256 KiB of the source; never throws. */
export async function readGcodeMetadata(
  source: GcodeByteSource,
): Promise<PrintFileMetadata> {
  try {
    const size = source.size
    if (!Number.isSafeInteger(size) || size <= 0)
      return emptyPrintFileMetadata()
    if (size <= GCODE_HEAD_BYTES + GCODE_TAIL_BYTES) {
      return parseGcodeMetadata(clip(await source.read(0, size), size))
    }
    const head = clip(await source.read(0, GCODE_HEAD_BYTES), GCODE_HEAD_BYTES)
    const tail = clip(
      await source.read(size - GCODE_TAIL_BYTES, GCODE_TAIL_BYTES),
      GCODE_TAIL_BYTES,
    )
    return parseGcodeMetadata(head, tail)
  } catch {
    return emptyPrintFileMetadata()
  }
}

/**
 * Parses a complete file (`head` only) or the two windows of a large one.
 * A cut-off line at a window edge is dropped. Never throws.
 */
export function parseGcodeMetadata(
  head: Uint8Array | string,
  tail?: Uint8Array | string,
): PrintFileMetadata {
  try {
    const headLines = splitLines(head, tail !== undefined, false)
    const lines =
      tail === undefined
        ? headLines
        : headLines.concat(splitLines(tail, false, true))
    const parsed = PrintFileMetadata.safeParse(new Scan().run(lines))
    return parsed.success ? parsed.data : emptyPrintFileMetadata()
  } catch {
    return emptyPrintFileMetadata()
  }
}

function clip(bytes: Uint8Array, max: number): Uint8Array {
  return bytes.length > max ? bytes.subarray(0, max) : bytes
}

function splitLines(
  input: Uint8Array | string,
  dropLast: boolean,
  dropFirst: boolean,
): string[] {
  const textValue =
    typeof input === 'string' ? input : new TextDecoder('latin1').decode(input)
  const lines = textValue.split('\n')
  if (dropFirst) lines.shift()
  if (dropLast) lines.pop()
  return lines
}

const clean = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^"+|"+$/g, '')
    .trim()
    .slice(0, MAX_TEXT)

const normKey = (key: string): string =>
  key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

function num(
  value: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : undefined
}

function list(value: string, separators: RegExp): string[] {
  return value
    .split(separators)
    .slice(0, MAX_TOOLS)
    .map((item) => item.trim())
}

function duration(value: string): number | undefined {
  if (/^\d+(\.\d+)?$/.test(value.trim())) return num(value, 0, 31_536_000)
  let total = 0
  let found = false
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])\b/gi)) {
    found = true
    const unit = { d: 86400, h: 3600, m: 60, s: 1 }[
      m[2]!.toLowerCase() as 'd' | 'h' | 'm' | 's'
    ]
    total += Number.parseFloat(m[1]!) * unit
  }
  return found && total <= 31_536_000 ? Math.round(total) : undefined
}

function canonicalSlicer(raw: string): string | undefined {
  const key = raw.toLowerCase().replace(/[^a-z]/g, '')
  if (key.includes('superslicer')) return 'SuperSlicer'
  if (key.includes('prusaslicer')) return 'PrusaSlicer'
  if (key.includes('orcaslicer')) return 'OrcaSlicer'
  if (key.includes('bambustudio')) return 'BambuStudio'
  if (key.includes('crealityprint')) return 'Creality Print'
  if (key.includes('anycubic')) return 'Anycubic Slicer Next'
  if (key.includes('cura')) return 'Cura'
  return undefined
}

const KNOWN_SLICER =
  /^(bambu ?studio|orca ?slicer|prusa ?slicer|super ?slicer|creality print|anycubic ?slicer ?next|cura)\b\s*v?(\d[\w.+-]*)/i
const GENERATED =
  /^generated (?:by|with)\s+(.+?)(?:\s+v?(\d[\w.+-]*))?(?:\s+on\b.*)?$/i
const BEGIN = /^(thumbnail(?:_\w+)?|png|jpe?g)\s+begin\s+(\d+)\s*[x*]\s*(\d+)/i
const END = /^(?:thumbnail(?:_\w+)?|png|jpe?g)\s+end\b/i
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

interface Pending {
  width: number
  height: number
  chunks: string[]
  chars: number
  oversize: boolean
}

class Scan {
  private slicer: { name: string; version?: string } | undefined
  private readonly fields = new Map<string, string>()
  private readonly nozzleByTool = new Map<number, number>()
  private readonly printing = new Set<string>()
  private readonly excluded = new Set<string>()
  private estimate: number | undefined
  private pending: Pending | undefined
  private best: { thumb: PrintFileThumbnail; area: number } | undefined

  run(lines: string[]): unknown {
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line.length > MAX_LINE) {
        this.pending = undefined
        continue
      }
      this.line(line.trim())
    }
    return this.build()
  }

  private line(line: string): void {
    if (this.pending) {
      this.thumbnailLine(line)
      return
    }
    if (line.startsWith('EXCLUDE_OBJECT_DEFINE')) {
      const name = /NAME=(\S+)/.exec(line)?.[1]
      if (name && this.excluded.size < MAX_SET) this.excluded.add(name)
      return
    }
    if (!line.startsWith(';')) return
    this.comment(line.slice(1).trim())
  }

  private thumbnailLine(line: string): void {
    const pending = this.pending!
    if (!line.startsWith(';')) {
      this.pending = undefined
      return
    }
    const body = line.slice(1).trim()
    if (END.test(body)) {
      this.pending = undefined
      if (!pending.oversize) this.finishThumbnail(pending)
      return
    }
    if (pending.oversize) return
    pending.chars += body.length
    if (pending.chars > MAX_THUMBNAIL_BASE64_CHARS) {
      pending.oversize = true
      pending.chunks = []
      return
    }
    pending.chunks.push(body)
  }

  private finishThumbnail(pending: Pending): void {
    const data = pending.chunks.join('')
    if (data.length < 16 || !BASE64.test(data)) return
    const head = Uint8Array.from(atob(data.slice(0, 32)), (c) =>
      c.charCodeAt(0),
    )
    const size =
      Math.floor((data.length * 3) / 4) -
      (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
    if (size <= 0 || size > MAX_THUMBNAIL_BYTES) return
    let format: 'png' | 'jpg'
    let { width, height } = pending
    if (PNG_MAGIC.every((byte, i) => head[i] === byte)) {
      format = 'png'
      if (head.length >= 24) {
        const view = new DataView(head.buffer)
        width = view.getUint32(16)
        height = view.getUint32(20)
      }
    } else if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      format = 'jpg'
    } else {
      return
    }
    const area = width * height
    if (!(width > 0 && height > 0 && width <= 16384 && height <= 16384)) return
    if (
      !this.best ||
      area > this.best.area ||
      (area === this.best.area && size > this.best.thumb.sizeBytes)
    ) {
      this.best = {
        area,
        thumb: { format, width, height, sizeBytes: size, dataBase64: data },
      }
    }
  }

  private comment(body: string): void {
    const begin = BEGIN.exec(body)
    if (begin) {
      this.pending = {
        width: Number(begin[2]),
        height: Number(begin[3]),
        chunks: [],
        chars: 0,
        oversize: false,
      }
      return
    }
    if (!this.slicer?.version) this.detectSlicer(body)
    const printing = /^printing object\s+.+$/i.exec(body)
    if (printing) {
      if (this.printing.size < MAX_SET) this.printing.add(body)
      return
    }
    const total = /total estimated time\s*:\s*([^;]+)/i.exec(body)
    if (total) this.estimate ??= duration(total[1]!)
    const cut = body.search(/[=:]/)
    if (cut <= 0) return
    const key = normKey(body.slice(0, cut))
    const value = body.slice(cut + 1).trim()
    if (key === 'flavor') {
      this.slicer ??= { name: 'Cura' }
      return
    }
    const trainNozzle = /^extruder_train_(\d+)_nozzle_diameter$/.exec(key)
    if (trainNozzle) {
      const index = Number(trainNozzle[1])
      const nozzle = num(value, 0.01, 10)
      if (
        index < MAX_TOOLS &&
        nozzle !== undefined &&
        !this.nozzleByTool.has(index)
      )
        this.nozzleByTool.set(index, nozzle)
      return
    }
    if (!this.fields.has(key)) this.fields.set(key, value)
  }

  private detectSlicer(body: string): void {
    const gen = GENERATED.exec(body)
    if (gen) {
      const name = canonicalSlicer(gen[1]!) ?? clean(gen[1]!)
      if (name)
        this.slicer = { name, ...(gen[2] ? { version: clean(gen[2]) } : {}) }
      return
    }
    const known = KNOWN_SLICER.exec(body)
    if (known)
      this.slicer = {
        name: canonicalSlicer(known[1]!)!,
        version: clean(known[2]!),
      }
  }

  private build(): unknown {
    const f = this.fields
    const get = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = f.get(key)
        if (value) return value
      }
      return undefined
    }
    const text = (...keys: string[]): string | undefined => {
      const value = get(...keys)
      const cleaned = value === undefined ? '' : clean(value)
      return cleaned || undefined
    }

    const layerHeight = num(get('layer_height'), 0.001, 10)
    const firstRaw = get('first_layer_height', 'initial_layer_print_height')
    const percent = firstRaw?.trim().endsWith('%') ?? false
    let first = num(
      percent ? firstRaw!.trim().slice(0, -1) : firstRaw,
      0.001,
      percent ? 1000 : 10,
    )
    if (percent)
      first =
        layerHeight !== undefined && first !== undefined
          ? num(String(Math.round(layerHeight * first) / 100), 0.001, 10)
          : undefined

    const nozzles = list(get('nozzle_diameter') ?? '', /,/)
    const types = list(get('filament_type') ?? '', /;/)
    const colours = list(get('filament_colour') ?? '', /[;,]/)
    const grams = list(
      get('filament_used_g', 'total_filament_weight_g') ?? '',
      /[,;]/,
    )
    const profiles = list(get('filament_settings_id') ?? '', /;/)
    const count = Math.min(
      MAX_TOOLS,
      Math.max(
        nozzles.filter(Boolean).length,
        types.filter(Boolean).length,
        colours.filter(Boolean).length,
        grams.filter(Boolean).length,
        profiles.filter(Boolean).length,
        this.nozzleByTool.size === 0
          ? 0
          : Math.max(...this.nozzleByTool.keys()) + 1,
      ),
    )
    const tools: PrintFileTool[] = []
    for (let i = 0; i < count; i++) {
      const tool: PrintFileTool = { index: i }
      const nozzle = this.nozzleByTool.get(i) ?? num(nozzles[i], 0.01, 10)
      if (nozzle !== undefined) tool.nozzleDiameterMm = nozzle
      const type = clean(types[i] ?? '')
      if (type) tool.filamentType = type
      const colour = clean(colours[i] ?? '').toUpperCase()
      if (/^#[0-9A-F]{6}([0-9A-F]{2})?$/.test(colour)) tool.colour = colour
      const weight = num(grams[i], 0, 1_000_000)
      if (weight !== undefined) tool.grams = weight
      const profile = clean(profiles[i] ?? '')
      if (profile) tool.filamentProfile = profile
      if (Object.keys(tool).length > 1) tools.push(tool)
    }

    const objects = Math.max(this.printing.size, this.excluded.size)
    const metadata: Record<string, unknown> = { tools }
    const set = (key: string, value: unknown): void => {
      if (value !== undefined) metadata[key] = value
    }
    set('slicer', this.slicer)
    set('printerModel', text('printer_model', 'target_machine_name'))
    set('printerProfile', text('printer_settings_id'))
    set('printProfile', text('print_settings_id'))
    set('layerHeightMm', layerHeight)
    set('firstLayerHeightMm', first)
    set('objectCount', objects > 0 ? objects : undefined)
    set('bedSizeMm', bedSize(get('printable_area', 'bed_shape')))
    set(
      'estimatedTimeSeconds',
      this.estimate ??
        (() => {
          const raw = get(
            'estimated_printing_time_normal_mode',
            'total_estimated_time',
            'estimated_print_time',
            'time',
          )
          return raw === undefined ? undefined : duration(raw)
        })(),
    )
    const layers = num(
      get('total_layer_number', 'total_layers_count', 'layer_count'),
      0,
      10_000_000,
    )
    set('totalLayers', layers === undefined ? undefined : Math.floor(layers))
    set('thumbnail', this.best?.thumb)
    return metadata
  }
}

function bedSize(
  value: string | undefined,
): { x: number; y: number } | undefined {
  if (!value) return undefined
  const xs: number[] = []
  const ys: number[] = []
  for (const point of value.split(',').slice(0, 64)) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*x\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(point)
    if (!m) return undefined
    xs.push(Number(m[1]))
    ys.push(Number(m[2]))
  }
  if (xs.length < 2) return undefined
  const x = Math.max(...xs) - Math.min(...xs)
  const y = Math.max(...ys) - Math.min(...ys)
  return x > 0 && y > 0 && x <= 100_000 && y <= 100_000 ? { x, y } : undefined
}
