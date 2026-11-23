/**
 * Canonical import bundle for existing spool libraries.
 *
 * `normalizeBundle` accepts the shapes Spoolman's REST API and JSON export use
 * (and the nested objects of its CSV export) and returns strictly validated
 * records keyed by their upstream id. Nothing here touches storage or the
 * network, so the same code serves the Spoolman reader, JSON and CSV import.
 */
import { createHash } from 'node:crypto'

export type ImportKind = 'vendor' | 'filament' | 'spool'

export interface ImportVendor {
  upstreamId: string
  name: string
  comment: string | null
  externalId: string | null
  extra: Record<string, unknown>
  registeredAt: number | null
}
export interface ImportFilament {
  upstreamId: string
  vendorUpstreamId: string | null
  name: string | null
  material: string | null
  colorHex: string | null
  density: number
  diameter: number
  weight: number | null
  spoolWeight: number | null
  price: number | null
  comment: string | null
  externalId: string | null
  extra: Record<string, unknown>
  registeredAt: number | null
}
export interface ImportSpool {
  upstreamId: string
  filamentUpstreamId: string
  initialWeight: number | null
  spoolWeight: number | null
  usedWeight: number
  price: number | null
  location: string | null
  lotNr: string | null
  comment: string | null
  archived: boolean
  extra: Record<string, unknown>
  registeredAt: number | null
  firstUsedAt: number | null
  lastUsedAt: number | null
}
export const FIELD_TYPES = [
  'text',
  'integer',
  'integer_range',
  'float',
  'float_range',
  'datetime',
  'boolean',
  'choice',
] as const
export interface ImportField {
  entityType: ImportKind
  key: string
  name: string
  fieldType: (typeof FIELD_TYPES)[number]
  order: number
  unit: string | null
  defaultValue: string | null
  choices: string[] | null
  multiChoice: boolean
}
export interface ImportSetting {
  key: string
  value: unknown
}

export interface ImportBundle {
  vendors: ImportVendor[]
  filaments: ImportFilament[]
  spools: ImportSpool[]
  fields: ImportField[]
  settings: ImportSetting[]
  /** Counts of values shortened to fit storage limits, and settings left out on purpose. */
  truncated: number
  skippedSettings: string[]
}

export interface BundleProblem {
  path: string
  problem: string
}
export type BundleResult =
  { ok: true; bundle: ImportBundle } | { ok: false; problems: BundleProblem[] }

export const LIMITS = {
  vendors: 5_000,
  filaments: 20_000,
  spools: 50_000,
  fields: 200,
  settings: 256,
} as const
const MAX_PROBLEMS = 20
const EXTRA_KEY = /^[a-z0-9_]{1,64}$/
/** Prefix for upstream columns the farm schema has no column for; never overrides a real extra field. */
export const PRESERVED_PREFIX = 'o3dfm_upstream_'
/** Settings that describe the upstream installation, not the library. */
const SKIPPED_SETTING = /^(base_url|extra_fields_[a-z_]+)$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deterministic JSON (sorted keys) so equal records always hash equally. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isObj(value))
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value ?? null)
}
export const sha256 = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')

class Collector {
  readonly problems: BundleProblem[] = []
  truncated = 0
  add(path: string, problem: string) {
    if (this.problems.length < MAX_PROBLEMS)
      this.problems.push({ path, problem })
    else if (this.problems.length === MAX_PROBLEMS)
      this.problems.push({ path: '...', problem: 'more problems omitted' })
  }
}

function id(c: Collector, path: string, v: unknown): string | null {
  const text =
    typeof v === 'number' && Number.isSafeInteger(v)
      ? String(v)
      : typeof v === 'string'
        ? v.trim()
        : ''
  if (!/^[1-9][0-9]{0,14}$/.test(text)) {
    c.add(path, 'a positive integer id is required')
    return null
  }
  return text
}
function refId(
  c: Collector,
  path: string,
  v: unknown,
): string | null | undefined {
  if (v === undefined || v === null || v === '') return null
  return id(c, path, v) ?? undefined
}
function str(c: Collector, v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null
  const text =
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null
  if (text === null) return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.length > max) {
    c.truncated++
    return trimmed.slice(0, max)
  }
  return trimmed
}
function num(
  c: Collector,
  path: string,
  v: unknown,
  rule: { min: number; positive?: boolean },
): number | null | undefined {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n < rule.min || (rule.positive && n <= 0)) {
    c.add(path, 'invalid number')
    return undefined
  }
  return n
}
function timestamp(v: unknown): number | null {
  if (typeof v !== 'string' || v.trim() === '') return null
  const t = v.trim()
  const ms = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(t) ? t : `${t}Z`)
  return Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER
    ? Math.trunc(ms)
    : null
}
function bool(c: Collector, path: string, v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim()))
    return v.trim().toLowerCase() === 'true'
  c.add(path, 'invalid boolean')
  return undefined
}
function extra(c: Collector, path: string, v: unknown): Obj {
  if (v === undefined || v === null) return {}
  if (!isObj(v)) {
    c.add(path, 'extra must be an object')
    return {}
  }
  const out: Obj = {}
  for (const [key, value] of Object.entries(v)) {
    if (!EXTRA_KEY.test(key) || key === '__proto__') {
      c.add(`${path}.${key.slice(0, 40)}`, 'invalid extra field key')
      continue
    }
    if (value !== null && typeof value === 'object') {
      c.add(`${path}.${key}`, 'extra values must be scalars or JSON text')
      continue
    }
    out[key] = value
  }
  return out
}
function withPreserved(base: Obj, preserved: Record<string, unknown>): Obj {
  const out = { ...base }
  for (const [name, value] of Object.entries(preserved)) {
    const key = PRESERVED_PREFIX + name
    if (value === undefined || value === null || value === '' || key in out)
      continue
    out[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return out
}
function fitExtra(c: Collector, path: string, e: Obj): Obj {
  if (JSON.stringify(e).length > 60_000) {
    c.add(path, 'extra is too large')
    return {}
  }
  return e
}

function vendor(c: Collector, raw: unknown, path: string): ImportVendor | null {
  if (!isObj(raw)) return (c.add(path, 'object expected'), null)
  const upstreamId = id(c, `${path}.id`, raw['id'])
  const name = str(c, raw['name'], 256)
  if (!name) c.add(`${path}.name`, 'name is required')
  const e = fitExtra(
    c,
    `${path}.extra`,
    withPreserved(extra(c, `${path}.extra`, raw['extra']), {
      empty_spool_weight: raw['empty_spool_weight'],
    }),
  )
  if (!upstreamId || !name) return null
  return {
    upstreamId,
    name,
    comment: str(c, raw['comment'], 1024),
    externalId: str(c, raw['external_id'], 256),
    extra: e,
    registeredAt: timestamp(raw['registered']),
  }
}

function filament(
  c: Collector,
  raw: unknown,
  path: string,
): ImportFilament | null {
  if (!isObj(raw)) return (c.add(path, 'object expected'), null)
  const upstreamId = id(c, `${path}.id`, raw['id'])
  const vendorRef = isObj(raw['vendor'])
    ? refId(c, `${path}.vendor.id`, raw['vendor']['id'])
    : refId(c, `${path}.vendor_id`, raw['vendor_id'])
  const density = num(c, `${path}.density`, raw['density'], {
    min: 0,
    positive: true,
  })
  const diameter = num(c, `${path}.diameter`, raw['diameter'], {
    min: 0,
    positive: true,
  })
  if (density === null) c.add(`${path}.density`, 'density is required')
  if (diameter === null) c.add(`${path}.diameter`, 'diameter is required')
  const weight = num(c, `${path}.weight`, raw['weight'], { min: 0 })
  const spoolWeight = num(c, `${path}.spool_weight`, raw['spool_weight'], {
    min: 0,
  })
  const price = num(c, `${path}.price`, raw['price'], { min: 0 })
  let colorHex: string | null = null
  const color = str(c, raw['color_hex'], 16)
  if (color) {
    const hex = color.replace(/^#/, '')
    if (/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(hex)) colorHex = hex
    else c.add(`${path}.color_hex`, 'invalid color')
  }
  const e = fitExtra(
    c,
    `${path}.extra`,
    withPreserved(extra(c, `${path}.extra`, raw['extra']), {
      article_number: raw['article_number'],
      settings_extruder_temp: raw['settings_extruder_temp'],
      settings_bed_temp: raw['settings_bed_temp'],
      multi_color_hexes: raw['multi_color_hexes'],
      multi_color_direction: raw['multi_color_direction'],
    }),
  )
  if (
    !upstreamId ||
    vendorRef === undefined ||
    typeof density !== 'number' ||
    typeof diameter !== 'number' ||
    weight === undefined ||
    spoolWeight === undefined ||
    price === undefined
  )
    return null
  return {
    upstreamId,
    vendorUpstreamId: vendorRef,
    name: str(c, raw['name'], 256),
    material: str(c, raw['material'], 64),
    colorHex,
    density,
    diameter,
    weight: weight === 0 ? null : weight,
    spoolWeight,
    price,
    comment: str(c, raw['comment'], 1024),
    externalId: str(c, raw['external_id'], 256),
    extra: e,
    registeredAt: timestamp(raw['registered']),
  }
}

function spool(c: Collector, raw: unknown, path: string): ImportSpool | null {
  if (!isObj(raw)) return (c.add(path, 'object expected'), null)
  const upstreamId = id(c, `${path}.id`, raw['id'])
  const filamentRef = isObj(raw['filament'])
    ? id(c, `${path}.filament.id`, raw['filament']['id'])
    : id(c, `${path}.filament_id`, raw['filament_id'])
  const initialWeight = num(
    c,
    `${path}.initial_weight`,
    raw['initial_weight'],
    { min: 0 },
  )
  const spoolWeight = num(c, `${path}.spool_weight`, raw['spool_weight'], {
    min: 0,
  })
  const usedWeight = num(c, `${path}.used_weight`, raw['used_weight'], {
    min: 0,
  })
  const price = num(c, `${path}.price`, raw['price'], { min: 0 })
  const archived = bool(c, `${path}.archived`, raw['archived'])
  const e = fitExtra(
    c,
    `${path}.extra`,
    extra(c, `${path}.extra`, raw['extra']),
  )
  if (
    !upstreamId ||
    !filamentRef ||
    initialWeight === undefined ||
    spoolWeight === undefined ||
    usedWeight === undefined ||
    price === undefined ||
    archived === undefined
  )
    return null
  return {
    upstreamId,
    filamentUpstreamId: filamentRef,
    initialWeight,
    spoolWeight,
    usedWeight: usedWeight ?? 0,
    price,
    location: str(c, raw['location'], 256),
    lotNr: str(c, raw['lot_nr'], 256),
    comment: str(c, raw['comment'], 1024),
    archived,
    extra: e,
    registeredAt: timestamp(raw['registered']),
    firstUsedAt: timestamp(raw['first_used']),
    lastUsedAt: timestamp(raw['last_used']),
  }
}

function field(
  c: Collector,
  raw: unknown,
  path: string,
  entityType: ImportKind | null,
): ImportField | null {
  if (!isObj(raw)) return (c.add(path, 'object expected'), null)
  const type = entityType ?? raw['entity_type']
  const key = typeof raw['key'] === 'string' ? raw['key'] : ''
  const name = str(c, raw['name'], 128)
  const fieldType = raw['field_type']
  const order = raw['order'] === undefined ? 0 : raw['order']
  const choices = raw['choices']
  const bad: BundleProblem[] = []
  if (type !== 'vendor' && type !== 'filament' && type !== 'spool')
    bad.push({ path: `${path}.entity_type`, problem: 'unknown entity type' })
  if (!EXTRA_KEY.test(key))
    bad.push({ path: `${path}.key`, problem: 'invalid field key' })
  if (!name) bad.push({ path: `${path}.name`, problem: 'name is required' })
  if (!FIELD_TYPES.includes(fieldType as never))
    bad.push({ path: `${path}.field_type`, problem: 'unknown field type' })
  if (
    typeof order !== 'number' ||
    !Number.isInteger(order) ||
    order < 0 ||
    order > 100_000
  )
    bad.push({ path: `${path}.order`, problem: 'invalid order' })
  if (
    choices !== undefined &&
    choices !== null &&
    !(
      Array.isArray(choices) &&
      choices.length <= 256 &&
      choices.every((x) => typeof x === 'string' && x.length <= 128)
    )
  )
    bad.push({ path: `${path}.choices`, problem: 'invalid choices' })
  if (bad.length > 0) {
    for (const p of bad) c.add(p.path, p.problem)
    return null
  }
  return {
    entityType: type as ImportKind,
    key,
    name: name as string,
    fieldType: fieldType as ImportField['fieldType'],
    order: order as number,
    unit: str(c, raw['unit'], 32),
    defaultValue: str(c, raw['default_value'], 1024),
    choices: Array.isArray(choices) ? (choices as string[]) : null,
    multiChoice: raw['multi_choice'] === true,
  }
}

function list(
  c: Collector,
  raw: unknown,
  path: string,
  max: number,
): unknown[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return (c.add(path, 'array expected'), [])
  if (raw.length > max) {
    c.add(path, `at most ${max} records are accepted`)
    return []
  }
  return raw
}

function settings(
  c: Collector,
  raw: unknown,
  skipped: string[],
): ImportSetting[] {
  if (raw === undefined || raw === null) return []
  if (!isObj(raw)) return (c.add('settings', 'object expected'), [])
  const entries = Object.entries(raw)
  if (entries.length > LIMITS.settings) {
    c.add('settings', `at most ${LIMITS.settings} settings are accepted`)
    return []
  }
  const out: ImportSetting[] = []
  for (const [key, entry] of entries) {
    if (!EXTRA_KEY.test(key) || key === '__proto__') {
      c.add(`settings.${key.slice(0, 40)}`, 'invalid setting key')
      continue
    }
    let value: unknown = entry
    if (
      isObj(entry) &&
      'value' in entry &&
      typeof entry['is_set'] === 'boolean'
    ) {
      // Spoolman shape: only settings the owner actually set, value is JSON text.
      if (entry['is_set'] !== true) continue
      try {
        value =
          typeof entry['value'] === 'string'
            ? JSON.parse(entry['value'])
            : entry['value']
      } catch {
        c.add(`settings.${key}`, 'value is not valid JSON')
        continue
      }
    }
    if (SKIPPED_SETTING.test(key)) {
      skipped.push(key)
      continue
    }
    if (value === undefined || JSON.stringify(value).length > 60_000) {
      c.add(`settings.${key}`, 'invalid or oversized value')
      continue
    }
    out.push({ key, value })
  }
  return out
}

/**
 * Turn upstream-shaped data into validated records. Vendors and filaments that
 * only appear nested inside filaments/spools are derived, so a bare spool
 * export (JSON or CSV) is a complete library.
 */
export function normalizeBundle(input: unknown): BundleResult {
  const c = new Collector()
  if (!isObj(input))
    return { ok: false, problems: [{ path: '', problem: 'object expected' }] }
  const rawVendors = list(c, input['vendors'], 'vendors', LIMITS.vendors)
  const rawFilaments = list(
    c,
    input['filaments'],
    'filaments',
    LIMITS.filaments,
  )
  const rawSpools = list(c, input['spools'], 'spools', LIMITS.spools)

  // Explicit records win; nested objects fill in what the top level lacks.
  const vendorSources = new Map<string, { raw: unknown; path: string }>()
  const filamentSources = new Map<string, { raw: unknown; path: string }>()
  const remember = (
    map: Map<string, { raw: unknown; path: string }>,
    raw: unknown,
    path: string,
    explicit: boolean,
  ) => {
    if (!isObj(raw)) return
    // A record without an id still has to be validated (and refused), never silently dropped.
    const key = raw['id'] === undefined ? `noid:${path}` : String(raw['id'])
    if (explicit || !map.has(key)) map.set(key, { raw, path })
  }
  rawVendors.forEach((r, i) =>
    remember(vendorSources, r, `vendors[${i}]`, true),
  )
  rawFilaments.forEach((r, i) =>
    remember(filamentSources, r, `filaments[${i}]`, true),
  )
  rawFilaments.forEach((r, i) => {
    if (isObj(r))
      remember(vendorSources, r['vendor'], `filaments[${i}].vendor`, false)
  })
  rawSpools.forEach((r, i) => {
    if (!isObj(r) || !isObj(r['filament'])) return
    remember(filamentSources, r['filament'], `spools[${i}].filament`, false)
    remember(
      vendorSources,
      r['filament']['vendor'],
      `spools[${i}].filament.vendor`,
      false,
    )
  })

  const vendors: ImportVendor[] = []
  const seenVendors = new Set<string>()
  for (const { raw, path } of vendorSources.values()) {
    const v = vendor(c, raw, path)
    if (v && !seenVendors.has(v.upstreamId))
      (seenVendors.add(v.upstreamId), vendors.push(v))
  }
  const filaments: ImportFilament[] = []
  for (const { raw, path } of filamentSources.values()) {
    const f = filament(c, raw, path)
    if (f) filaments.push(f)
  }
  const spoolIds = new Set<string>()
  const spools: ImportSpool[] = []
  rawSpools.forEach((raw, i) => {
    const s = spool(c, raw, `spools[${i}]`)
    if (!s) return
    if (spoolIds.has(s.upstreamId))
      return c.add(`spools[${i}].id`, 'duplicate id')
    spoolIds.add(s.upstreamId)
    spools.push(s)
  })
  for (const [name, items] of [
    ['vendors', rawVendors],
    ['filaments', rawFilaments],
  ] as const) {
    const seen = new Set<string>()
    items.forEach((r, i) => {
      const key = isObj(r) ? String(r['id']) : ''
      if (seen.has(key)) c.add(`${name}[${i}].id`, 'duplicate id')
      seen.add(key)
    })
  }

  const fields: ImportField[] = []
  const rawFields = input['fields']
  if (Array.isArray(rawFields))
    list(c, rawFields, 'fields', LIMITS.fields).forEach((r, i) => {
      const f = field(c, r, `fields[${i}]`, null)
      if (f) fields.push(f)
    })
  else if (isObj(rawFields))
    for (const kind of ['vendor', 'filament', 'spool'] as const)
      list(c, rawFields[kind], `fields.${kind}`, LIMITS.fields).forEach(
        (r, i) => {
          const f = field(c, r, `fields.${kind}[${i}]`, kind)
          if (f) fields.push(f)
        },
      )
  else if (rawFields !== undefined && rawFields !== null)
    c.add('fields', 'array or object expected')
  const fieldKeys = new Set<string>()
  for (const f of fields) {
    const k = `${f.entityType}/${f.key}`
    if (fieldKeys.has(k)) c.add('fields', 'duplicate field definition')
    fieldKeys.add(k)
  }
  if (fields.length > LIMITS.fields * 3) c.add('fields', 'too many fields')

  const skippedSettings: string[] = []
  const parsedSettings = settings(c, input['settings'], skippedSettings)

  if (c.problems.length > 0) return { ok: false, problems: c.problems }
  const sort = <T extends { upstreamId: string }>(a: T[]) =>
    a.sort((x, y) => Number(x.upstreamId) - Number(y.upstreamId))
  return {
    ok: true,
    bundle: {
      vendors: sort(vendors),
      filaments: sort(filaments),
      spools: sort(spools),
      fields: fields.sort((a, b) =>
        `${a.entityType}/${a.key}`.localeCompare(`${b.entityType}/${b.key}`),
      ),
      settings: parsedSettings.sort((a, b) => a.key.localeCompare(b.key)),
      truncated: c.truncated,
      skippedSettings: skippedSettings.sort(),
    },
  }
}
