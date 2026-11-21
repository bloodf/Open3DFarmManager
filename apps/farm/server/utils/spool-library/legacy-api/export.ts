/**
 * `GET /api/v1/export/{vendors,filaments,spools}` of the pinned Spoolman
 * v0.27.1 and the farm-scoped bundle `POST /api/v1/backup` returns. Both read
 * only through the farm-bound repository.
 */
import type {
  Result,
  Spool,
  SpoolFilament,
  SpoolLibraryRepository,
  SpoolVendor,
} from '../scope.ts'
import { ENTITY_TYPES } from './aux-common.ts'
import { fieldJson } from './field.ts'
import { pyFloatText, spoolmanDateTime } from './compat.ts'
import {
  extraOf,
  filamentJson,
  loadAll,
  sanitizeColor,
  sanitizeMultiColor,
  spoolJson,
  vendorJson,
} from './records.ts'
import { SETTING_DEFINITIONS, settingViews } from './setting.ts'
import {
  methodNotAllowed,
  respond,
  lastQueryValue,
  type LegacyApiModule,
} from './types.ts'
import { asBool, unprocessable, type Issue } from './validation.ts'

interface Loaded {
  vendors: SpoolVendor[]
  filaments: SpoolFilament[]
  spools: Spool[]
}

async function load(repo: SpoolLibraryRepository): Promise<Result<Loaded>> {
  const vendors = await loadAll((page) => repo.vendors.list(page))
  if (!vendors.ok) return vendors
  const filaments = await loadAll((page) => repo.filaments.list(page))
  if (!filaments.ok) return filaments
  const spools = await loadAll((page) => repo.spools.list(page))
  if (!spools.ok) return spools
  return {
    ok: true,
    value: {
      vendors: vendors.value,
      filaments: filaments.value,
      spools: spools.value,
    },
  }
}

function filamentRows(data: Loaded) {
  const vendors = new Map(data.vendors.map((v) => [v.id, v]))
  return data.filaments.map((f) =>
    filamentJson(
      f,
      f.vendorId === null ? null : (vendors.get(f.vendorId) ?? null),
    ),
  )
}

function spoolRows(data: Loaded, allowArchived: boolean) {
  const vendors = new Map(data.vendors.map((v) => [v.id, v]))
  const filaments = new Map(data.filaments.map((f) => [f.id, f]))
  const rows: Record<string, unknown>[] = []
  for (const spool of data.spools) {
    if (spool.archived && !allowArchived) continue
    const filament = filaments.get(spool.filamentId)
    if (!filament) continue
    rows.push(
      spoolJson(
        spool,
        filament,
        filament.vendorId === null
          ? null
          : (vendors.get(filament.vendorId) ?? null),
      ),
    )
  }
  return rows
}

/**
 * Everything this farm holds, in the shape the library import accepts
 * (`spoolman-api`): records, extra-field definitions and the settings that
 * have been set.
 */
export async function exportBundle(
  repo: SpoolLibraryRepository,
): Promise<Result<Record<string, unknown>>> {
  const data = await load(repo)
  if (!data.ok) return data
  const fields: Record<string, unknown[]> = {}
  for (const entity of ENTITY_TYPES) {
    const defs = await repo.extraFields.list(entity)
    if (!defs.ok) return defs
    fields[entity] = [...defs.value]
      .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1))
      .map(fieldJson)
  }
  const views = await settingViews(repo)
  if (!views.ok) return views
  const settings = Object.fromEntries(
    Object.entries(views.value).filter(
      ([key]) => !SETTING_DEFINITIONS[key]?.registryOf,
    ),
  )
  return {
    ok: true,
    value: {
      vendors: data.value.vendors.map(vendorJson),
      filaments: filamentRows(data.value),
      spools: spoolRows(data.value, true),
      fields,
      settings,
    },
  }
}

/** A Python `float`: JSON writes it as a number, CSV as `repr`. */
interface PyFloat {
  float: number | null
}
type Cell = string | number | boolean | null | PyFloat
const isFloat = (value: Cell): value is PyFloat =>
  typeof value === 'object' && value !== null

const f = (value: number | null): PyFloat => ({ float: value })
/** `str(datetime)` of a naive UTC timestamp. */
const dt = (ms: number | null) =>
  ms === null ? null : spoolmanDateTime(ms).replace('T', ' ').replace('Z', '')

type Row = Map<string, Cell>

/**
 * The flattening of upstream's `flatten_sqlalchemy_object`: attributes in
 * alphabetical order, a nested object expanded in place under `<attr>.`,
 * `extra` as one `extra.<key>` member per value, tags as one text of UIDs.
 */
function flatten(
  attrs: Record<string, Cell | Row | Record<string, string>>,
  prefix = '',
  out: Row = new Map(),
): Row {
  for (const name of Object.keys(attrs).sort()) {
    const value = attrs[name]!
    if (name === 'extra') {
      for (const key of Object.keys(value as Record<string, string>).sort())
        out.set(
          `${prefix}extra.${key}`,
          (value as Record<string, string>)[key]!,
        )
    } else if (value instanceof Map) {
      for (const [key, inner] of value)
        out.set(`${prefix}${name}.${key}`, inner)
    } else out.set(`${prefix}${name}`, value as Cell)
  }
  return out
}

const vendorAttrs = (vendor: SpoolVendor) => ({
  comment: vendor.comment,
  empty_spool_weight: f(vendor.emptySpoolWeight),
  external_id: vendor.externalId,
  extra: extraOf(vendor.extra),
  id: vendor.id,
  name: vendor.name,
  registered: dt(vendor.registeredAt),
})

const filamentAttrs = (filament: SpoolFilament, vendor: SpoolVendor | null) => {
  const out: Record<string, Cell | Row | Record<string, string>> = {
    article_number: filament.articleNumber,
    color_hex: sanitizeColor(filament.colorHex),
    comment: filament.comment,
    density: f(filament.density),
    diameter: f(filament.diameter),
    external_id: filament.externalId,
    extra: extraOf(filament.extra),
    id: filament.id,
    material: filament.material,
    multi_color_direction: filament.multiColorDirection,
    multi_color_hexes: sanitizeMultiColor(filament.multiColorHexes),
    name: filament.name,
    price: f(filament.price),
    registered: dt(filament.registeredAt),
    settings_bed_temp: filament.settingsBedTemp,
    settings_extruder_temp: filament.settingsExtruderTemp,
    spool_weight: f(filament.spoolWeight),
    // No tag storage: the UID list of every record is empty.
    tags: '',
    vendor: vendor ? flatten(vendorAttrs(vendor)) : null,
    vendor_id: filament.vendorId,
    weight: f(filament.weight),
  }
  return out
}

function spoolAttrs(
  spool: Spool,
  filament: SpoolFilament,
  vendor: SpoolVendor | null,
) {
  return {
    archived: spool.archived,
    comment: spool.comment,
    extra: extraOf(spool.extra),
    filament: flatten(filamentAttrs(filament, vendor)),
    filament_id: spool.filamentId,
    first_used: dt(spool.firstUsedAt),
    id: spool.id,
    initial_weight: f(spool.initialWeight),
    last_used: dt(spool.lastUsedAt),
    location: spool.location,
    lot_nr: spool.lotNr,
    price: f(spool.price),
    registered: dt(spool.registeredAt),
    spool_weight: f(spool.spoolWeight),
    tags: '',
    used_weight: f(spool.usedWeight),
  }
}

function exportRows(
  entity: string,
  data: Loaded,
  allowArchived: boolean,
): Row[] {
  const vendors = new Map(data.vendors.map((v) => [v.id, v]))
  if (entity === 'vendors')
    return data.vendors.map((v) => flatten(vendorAttrs(v)))
  if (entity === 'filaments')
    return data.filaments.map((fil) =>
      flatten(
        filamentAttrs(
          fil,
          fil.vendorId === null ? null : (vendors.get(fil.vendorId) ?? null),
        ),
      ),
    )
  const filaments = new Map(data.filaments.map((fil) => [fil.id, fil]))
  const rows: Row[] = []
  for (const spool of data.spools) {
    if (spool.archived && !allowArchived) continue
    const filament = filaments.get(spool.filamentId)
    if (!filament) continue
    rows.push(
      flatten(
        spoolAttrs(
          spool,
          filament,
          filament.vendorId === null
            ? null
            : (vendors.get(filament.vendorId) ?? null),
        ),
      ),
    )
  }
  return rows
}

const FORMULA = ['=', '+', '-', '@', '\t', '\r']

/** Python `csv.DictWriter` (excel dialect) over the escaped cells. */
function csvCell(value: Cell | undefined): string {
  let text: string
  if (value === undefined || value === null) text = ''
  else if (isFloat(value))
    text = value.float === null ? '' : pyFloatText(value.float)
  else if (typeof value === 'boolean') text = value ? 'True' : 'False'
  else if (typeof value === 'number') text = String(value)
  else text = FORMULA.some((p) => value.startsWith(p)) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function dumpCsv(rows: readonly Row[]): string {
  const headers = [...new Set(rows.flatMap((row) => [...row.keys()]))].sort()
  const lines = [headers.map(csvCell).join(',')]
  for (const row of rows)
    lines.push(headers.map((key) => csvCell(row.get(key))).join(','))
  return lines.join('\r\n') + '\r\n'
}

const jsonCell = (value: Cell): unknown =>
  isFloat(value) ? value.float : value

export function dumpJson(rows: readonly Row[]): unknown[] {
  return rows.map((row) =>
    Object.fromEntries([...row].map(([key, value]) => [key, jsonCell(value)])),
  )
}

export const exportModule: LegacyApiModule = {
  name: 'export',
  async handle(repo, request) {
    const match = /^\/api\/v1\/export\/(vendors|filaments|spools)$/.exec(
      request.apiPath,
    )
    if (!match) return undefined
    if (request.method !== 'GET') return methodNotAllowed()
    const issues: Issue[] = []
    const fmt = lastQueryValue(request.query, 'fmt')
    if (fmt === null)
      issues.push({
        type: 'missing',
        loc: ['query', 'fmt'],
        msg: 'Field required',
        input: null,
      })
    else if (fmt !== 'csv' && fmt !== 'json')
      issues.push({
        type: 'enum',
        loc: ['query', 'fmt'],
        msg: "Input should be 'csv' or 'json'",
        input: fmt,
        ctx: { expected: "'csv' or 'json'" },
      })
    let allowArchived = false
    const rawArchived = lastQueryValue(request.query, 'allow_archived')
    if (match[1] === 'spools' && rawArchived !== null) {
      const parsed = asBool(['query', 'allow_archived'], rawArchived)
      if (parsed.ok) allowArchived = parsed.value
      else issues.push(parsed.issue)
    }
    if (issues.length) return unprocessable(issues)
    const data = await load(repo)
    if (!data.ok) return data
    const rows = exportRows(match[1]!, data.value, allowArchived)
    const disposition = {
      'content-disposition': `attachment; filename="${match[1]}.${fmt}"`,
    }
    if (fmt === 'csv')
      return respond(200, dumpCsv(rows), {
        ...disposition,
        'content-type': 'text/csv; charset=utf-8',
      })
    return respond(200, dumpJson(rows), disposition)
  },
}
