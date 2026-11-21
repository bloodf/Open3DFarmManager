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
import { filamentJson, loadAll, spoolJson, vendorJson } from './records.ts'
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

function flatten(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value))
      flatten(inner, prefix ? `${prefix}.${key}` : key, out)
    return
  }
  out.set(prefix, Array.isArray(value) ? JSON.stringify(value) : value)
}

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** RFC 4180 CSV: nested objects become dotted columns, lists become JSON text. */
export function toCsv(rows: readonly Record<string, unknown>[]): string {
  const flat = rows.map((row) => {
    const out = new Map<string, unknown>()
    flatten(row, '', out)
    return out
  })
  const header: string[] = []
  const seen = new Set<string>()
  for (const row of flat)
    for (const key of row.keys())
      if (!seen.has(key)) {
        seen.add(key)
        header.push(key)
      }
  const lines = [header.map(cell).join(',')]
  for (const row of flat)
    lines.push(header.map((k) => cell(row.get(k))).join(','))
  return lines.join('\r\n') + '\r\n'
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
    const rows =
      match[1] === 'vendors'
        ? data.value.vendors.map(vendorJson)
        : match[1] === 'filaments'
          ? filamentRows(data.value)
          : spoolRows(data.value, allowArchived)
    if (fmt === 'csv')
      return respond(200, toCsv(rows), {
        'content-type': 'text/csv; charset=utf-8',
      })
    return respond(200, rows)
  },
}
