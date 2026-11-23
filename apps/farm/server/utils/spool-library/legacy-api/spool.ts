/**
 * `/api/v1/spool`, `/api/v1/spool/{spool_id}`, `/api/v1/spool/{spool_id}/use`
 * and `/api/v1/spool/{spool_id}/measure` of the pinned Spoolman v0.27.1
 * (`spoolman/api/v1/spool.py`), bound to one farm.
 * Group, field-rename and tag subpaths belong to sibling modules.
 */
import type {
  Spool,
  SpoolExtraFieldDefinition,
  SpoolFilament,
  SpoolInput,
  SpoolLibraryRepository,
  SpoolVendor,
} from '../scope.ts'
import { normalizeUid } from './color.ts'
import {
  compileExtraFilters,
  extraDictError,
  extraSortValue,
  mergeExtra,
} from './extra-fields.ts'
import { FILAMENT_MODEL, ID_LIST, patternIssue } from './filament.ts'
import {
  paginate,
  parseSort,
  resolveColumn,
  sortRows,
  stringFilter,
  type Direction,
  type Model,
  type SortKey,
} from './listing.ts'
import { loadAll, notFound, spoolJson, weightFromLength } from './records.ts'
import {
  MUTATING,
  failure,
  lastQueryValue,
  message,
  methodNotAllowed,
  respond,
  type LegacyApiModule,
  type LegacyApiRequest,
  type LegacyModuleResult,
} from './types.ts'
import {
  asBool,
  byFieldOrder,
  checkBody,
  parseIsoUtcMs,
  pathInt,
  unprocessable,
  valueError,
  type FieldSpec,
  type Issue,
} from './validation.ts'
import { pageQuery } from './vendor.ts'

type HydratedFilament = SpoolFilament & { vendor: SpoolVendor | null }
type Row = Spool & { filament: HydratedFilament }

const truncSec = (ms: number | null) =>
  ms === null ? null : Math.floor(ms / 1000) * 1000

const SPOOL_MODEL: Model<Row> = {
  name: 'Spool',
  columns: {
    id: (s) => s.id,
    registered: (s) => Math.floor(s.registeredAt / 1000),
    first_used: (s) =>
      s.firstUsedAt === null ? null : Math.floor(s.firstUsedAt / 1000),
    last_used: (s) =>
      s.lastUsedAt === null ? null : Math.floor(s.lastUsedAt / 1000),
    price: (s) => s.price,
    filament_id: (s) => s.filamentId,
    initial_weight: (s) => s.initialWeight,
    spool_weight: (s) => s.spoolWeight,
    used_weight: (s) => s.usedWeight,
    location: (s) => s.location,
    lot_nr: (s) => s.lotNr,
    comment: (s) => s.comment,
    archived: (s) => s.archived,
  },
  relations: {
    filament: { model: FILAMENT_MODEL as Model<never>, get: (s) => s.filament },
  },
}

const FIELDS = (update: boolean): [string, FieldSpec][] => [
  ['first_used', { kind: 'datetime' }],
  ['last_used', { kind: 'datetime' }],
  ['filament_id', { kind: 'int', required: !update }],
  ['price', { kind: 'float', ge: 0 }],
  ['initial_weight', { kind: 'float', ge: 0 }],
  ['spool_weight', { kind: 'float', ge: 0 }],
  ['remaining_weight', { kind: 'float', ge: 0 }],
  ['used_weight', { kind: 'float', ge: 0 }],
  ['location', { kind: 'str', max: 64 }],
  ['lot_nr', { kind: 'str', max: 64 }],
  ['comment', { kind: 'str', max: 1024 }],
  ['archived', { kind: 'bool', nullable: false }],
  ['extra', { kind: 'extra' }],
]

const USE_FIELDS: [string, FieldSpec][] = [
  ['use_length', { kind: 'float' }],
  ['use_weight', { kind: 'float' }],
]

const MEASURE_FIELDS: [string, FieldSpec][] = [
  ['weight', { kind: 'float', required: true }],
]

function parseSpoolBody(
  request: LegacyApiRequest,
  update: boolean,
  prefix: Issue[],
) {
  const fields = FIELDS(update)
  const body = checkBody(request.body, fields)
  if (body.fatal) return { issues: [...prefix, ...body.issues] }
  const rules: Issue[] = []
  if (update && body.set.has('filament_id') && body.values.filament_id === null)
    rules.push(
      valueError(['body', 'filament_id'], null, 'Value must not be None.'),
    )
  const allIssues = byFieldOrder([...body.issues, ...rules], fields)
  if (prefix.length || allIssues.length)
    return { issues: [...prefix, ...allIssues] }
  return { values: body.values, set: body.set }
}

async function extraError(
  repo: SpoolLibraryRepository,
  extra: Record<string, string | null> | null | undefined,
) {
  if (!extra || !Object.keys(extra).length) return null
  const fields = await repo.extraFields.list('spool')
  if (!fields.ok) return fields
  const error = extraDictError(fields.value, extra)
  return error ? message(400, error) : null
}

async function hydrateSpool(
  repo: SpoolLibraryRepository,
  spool: Spool,
  loadedFilament?: SpoolFilament,
  loadedVendor?: SpoolVendor | null,
): Promise<LegacyModuleResult> {
  const filament = loadedFilament
    ? { ok: true as const, value: loadedFilament }
    : await repo.filaments.get(spool.filamentId)
  if (!filament.ok) return filament
  let vendor: SpoolVendor | null = null
  if (loadedVendor !== undefined) {
    vendor = loadedVendor
  } else if (filament.value.vendorId !== null) {
    const fetched = await repo.vendors.get(filament.value.vendorId)
    if (!fetched.ok) return fetched
    vendor = fetched.value
  }
  return respond(200, spoolJson(spool, filament.value, vendor))
}

/** Longest prefix first, matching upstream `_EXTRA_FILTER_PREFIXES`. */
function parseSpoolExtraFilters(query: URLSearchParams) {
  const spool = new Map<string, string>()
  const filament = new Map<string, string>()
  const vendor = new Map<string, string>()
  for (const [key, value] of query) {
    if (key.startsWith('filament.vendor.extra.'))
      vendor.set(key.slice(22), value)
    else if (key.startsWith('filament.extra.'))
      filament.set(key.slice(15), value)
    else if (key.startsWith('extra.')) spool.set(key.slice(6), value)
  }
  return { spool, filament, vendor }
}

function parseDatetimeBound(raw: string, fieldName: string): number {
  const ms = parseIsoUtcMs(raw.trim(), true)
  if (ms === null)
    throw new Error(
      `Invalid datetime '${raw}' for '${fieldName}'. Expected an ISO 8601 datetime, e.g. 2024-05-01T00:00:00Z.`,
    )
  return ms
}

/** Upstream `add_where_clause_datetime_opt`. Throws Error(msg) for 400. */
export function compileDatetimeFilter(
  value: string | null,
  fieldName: string,
): ((ms: number | null) => boolean) | null {
  if (value === null) return null
  const checks: ((ms: number | null) => boolean)[] = []
  for (const rawPart of value.split(',')) {
    if (rawPart.length === 0) {
      checks.push((ms) => ms === null)
      continue
    }
    const part =
      rawPart.length > 1 && rawPart[0] === '"' && rawPart.at(-1) === '"'
        ? rawPart.slice(1, -1)
        : rawPart
    const bar = part.indexOf('|')
    if (bar === -1) {
      const target = parseDatetimeBound(part, fieldName)
      checks.push((ms) => ms !== null && truncSec(ms) === target)
      continue
    }
    const startStr = part.slice(0, bar)
    const endStr = part.slice(bar + 1)
    if (!startStr && !endStr)
      throw new Error(
        `Invalid datetime range filter for '${fieldName}': '${part}'. Expected '<start>|<end>' with at least one end given.`,
      )
    const startMs = startStr ? parseDatetimeBound(startStr, fieldName) : null
    const endMs = endStr ? parseDatetimeBound(endStr, fieldName) : null
    checks.push((ms) => {
      if (ms === null) return false
      const t = truncSec(ms)!
      return (
        (startMs === null || t >= startMs) && (endMs === null || t <= endMs)
      )
    })
  }
  return (ms) => checks.some((fn) => fn(ms))
}

function spoolSortKeys(
  sort: Map<string, Direction>,
  fields: readonly SpoolExtraFieldDefinition[],
): SortKey<Row>[] | string {
  const keys: SortKey<Row>[] = []
  const lookup = new Map(fields.map((f) => [f.key, f]))
  for (const [name, direction] of sort) {
    if (!name.startsWith('extra.')) continue
    const field = lookup.get(name.slice(6))
    if (field)
      keys.push({
        get: (row) => extraSortValue(field, row.extra[field.key]),
        direction,
      })
  }
  for (const [name, direction] of sort) {
    if (name.startsWith('extra.')) continue
    if (name === 'remaining_weight') {
      keys.push({
        get: (row) => {
          const w = row.initialWeight ?? row.filament.weight
          return w === null ? null : w - row.usedWeight
        },
        direction,
      })
    } else if (name === 'remaining_length') {
      keys.push({
        get: (row) => {
          const w = row.initialWeight ?? row.filament.weight
          return w === null
            ? null
            : (w - row.usedWeight) /
                row.filament.density /
                (row.filament.diameter * row.filament.diameter)
        },
        direction,
      })
    } else if (name === 'used_length') {
      keys.push({
        get: (row) =>
          row.usedWeight /
          row.filament.density /
          (row.filament.diameter * row.filament.diameter),
        direction,
      })
    } else if (name === 'filament.combined_name') {
      keys.push({ get: (row) => row.filament.vendor?.name ?? null, direction })
      keys.push({ get: (row) => row.filament.name, direction })
    } else if (name === 'price') {
      keys.push({ get: (row) => row.price ?? row.filament.price, direction })
    } else {
      const get = resolveColumn(SPOOL_MODEL, name)
      if (typeof get === 'string') return get
      keys.push({ get, direction })
    }
  }
  return keys
}

async function find(
  repo: SpoolLibraryRepository,
  query: URLSearchParams,
): Promise<LegacyModuleResult> {
  const issues: Issue[] = []
  const q = (key: string) => lastQueryValue(query, key)
  for (const key of [
    'filament_id',
    'vendor_id',
    'filament.id',
    'filament.vendor.id',
  ]) {
    const value = q(key)
    if (value !== null && !ID_LIST.test(value))
      issues.push(patternIssue(key, value))
  }
  let allowArchived = false
  const rawArchived = q('allow_archived')
  if (rawArchived !== null) {
    const parsed = asBool(['query', 'allow_archived'], rawArchived)
    if (parsed.ok) allowArchived = parsed.value
    else issues.push(parsed.issue)
  }
  const { limit, offset } = pageQuery(query, issues)
  if (issues.length) return unprocessable(issues)
  const sort = parseSort(q('sort'))
  if (typeof sort === 'string') return message(400, sort)

  const tag = q('tag')
  if (tag !== null) {
    const normalized = normalizeUid(tag)
    if ('error' in normalized) return message(400, normalized.error)
  }

  let byFirstUsed: ((ms: number | null) => boolean) | null
  let byLastUsed: ((ms: number | null) => boolean) | null
  let byRegistered: ((ms: number | null) => boolean) | null
  try {
    byFirstUsed = compileDatetimeFilter(q('first_used'), 'first_used')
    byLastUsed = compileDatetimeFilter(q('last_used'), 'last_used')
    byRegistered = compileDatetimeFilter(q('registered'), 'registered')
  } catch (error) {
    return message(400, (error as Error).message)
  }

  const extraMaps = parseSpoolExtraFilters(query)
  const needsSpoolFields =
    extraMaps.spool.size > 0 ||
    [...sort.keys()].some((k) => k.startsWith('extra.'))
  const spoolFieldsRes = needsSpoolFields
    ? await repo.extraFields.list('spool')
    : { ok: true as const, value: [] as SpoolExtraFieldDefinition[] }
  if (!spoolFieldsRes.ok) return spoolFieldsRes

  let spoolExtraFilters: ((extra: Record<string, unknown>) => boolean)[] = []
  let filamentExtraFilters: ((extra: Record<string, unknown>) => boolean)[] = []
  let vendorExtraFilters: ((extra: Record<string, unknown>) => boolean)[] = []
  try {
    if (extraMaps.spool.size)
      spoolExtraFilters = compileExtraFilters(
        spoolFieldsRes.value,
        extraMaps.spool,
      )
    if (extraMaps.filament.size) {
      const filamentFields = await repo.extraFields.list('filament')
      if (!filamentFields.ok) return filamentFields
      filamentExtraFilters = compileExtraFilters(
        filamentFields.value,
        extraMaps.filament,
      )
    }
    if (extraMaps.vendor.size) {
      const vendorFields = await repo.extraFields.list('vendor')
      if (!vendorFields.ok) return vendorFields
      vendorExtraFilters = compileExtraFilters(
        vendorFields.value,
        extraMaps.vendor,
      )
    }
  } catch (error) {
    return message(400, (error as Error).message)
  }

  const keys = spoolSortKeys(sort, spoolFieldsRes.value)
  if (typeof keys === 'string') return message(400, keys)

  const spools = await loadAll((page) => repo.spools.list(page))
  if (!spools.ok) return spools
  const filaments = await loadAll((page) => repo.filaments.list(page))
  if (!filaments.ok) return filaments
  const vendors = await loadAll((page) => repo.vendors.list(page))
  if (!vendors.ok) return vendors

  const vendorById = new Map(vendors.value.map((v) => [v.id, v]))
  const filamentById = new Map<number, HydratedFilament>(
    filaments.value.map((f) => [
      f.id,
      {
        ...f,
        vendor:
          f.vendorId === null ? null : (vendorById.get(f.vendorId) ?? null),
      },
    ]),
  )
  const rows: Row[] = []
  for (const s of spools.value) {
    const f = filamentById.get(s.filamentId)
    if (f) rows.push({ ...s, filament: f })
  }

  const filamentIdsRaw = q('filament.id') ?? q('filament_id')
  const filamentIds =
    filamentIdsRaw === null ? null : filamentIdsRaw.split(',').map(Number)
  const vendorIdsRaw = q('filament.vendor.id') ?? q('vendor_id')
  const vendorIds =
    vendorIdsRaw === null ? null : vendorIdsRaw.split(',').map(Number)
  const byVendorName = stringFilter(
    q('filament.vendor.name') ?? q('vendor_name'),
    false,
  )
  const byFilamentName = stringFilter(
    q('filament.name') ?? q('filament_name'),
    true,
  )
  const byMaterial = stringFilter(
    q('filament.material') ?? q('filament_material'),
    true,
  )
  const byMultiColorDir = stringFilter(
    q('filament.multi_color_direction'),
    true,
  )
  const byLocation = stringFilter(q('location'), true)
  const byLotNr = stringFilter(q('lot_nr'), true)

  const matched = rows.filter(
    (s) =>
      // No tag is linked to a spool until the tag module exists.
      tag === null &&
      (allowArchived || !s.archived) &&
      (!filamentIds || filamentIds.includes(s.filamentId)) &&
      (!vendorIds ||
        vendorIds.some((id) =>
          id === -1 ? s.filament.vendorId === null : s.filament.vendorId === id,
        )) &&
      (!byVendorName || byVendorName(s.filament.vendor?.name)) &&
      (!byFilamentName || byFilamentName(s.filament.name)) &&
      (!byMaterial || byMaterial(s.filament.material)) &&
      (!byMultiColorDir || byMultiColorDir(s.filament.multiColorDirection)) &&
      (!byLocation || byLocation(s.location)) &&
      (!byLotNr || byLotNr(s.lotNr)) &&
      (!byFirstUsed || byFirstUsed(s.firstUsedAt)) &&
      (!byLastUsed || byLastUsed(s.lastUsedAt)) &&
      (!byRegistered || byRegistered(s.registeredAt)) &&
      spoolExtraFilters.every((match) => match(s.extra)) &&
      filamentExtraFilters.every((match) => match(s.filament.extra)) &&
      vendorExtraFilters.every((match) =>
        match(s.filament.vendor?.extra ?? {}),
      ),
  )

  const { page, total } = paginate(sortRows(matched, keys), limit, offset)
  return respond(
    200,
    page.map((s) => spoolJson(s, s.filament, s.filament.vendor)),
    { 'x-total-count': String(total) },
  )
}

async function get(
  repo: SpoolLibraryRepository,
  rawId: string,
): Promise<LegacyModuleResult> {
  const id = pathInt('spool_id', rawId)
  if (!id.ok) return unprocessable([id.issue])
  const spool = await repo.spools.get(id.value)
  if (spool.ok) return hydrateSpool(repo, spool.value)
  return spool.reason === 'not-found'
    ? message(404, notFound('spool', id.value))
    : spool
}

async function create(
  repo: SpoolLibraryRepository,
  request: LegacyApiRequest,
): Promise<LegacyModuleResult> {
  const parsed = parseSpoolBody(request, false, [])
  if ('issues' in parsed) return unprocessable(parsed.issues!)
  const v = parsed.values
  const remainingWeight = (v.remaining_weight ?? null) as number | null
  let usedWeight = (v.used_weight ?? null) as number | null
  if (remainingWeight !== null && usedWeight !== null)
    return message(400, 'Only specify either remaining_weight or used_weight.')
  const extra = (v.extra ?? null) as Record<string, string | null> | null
  const extraFailure = await extraError(repo, extra)
  if (extraFailure) return extraFailure

  const filamentId = v.filament_id as number
  const filament = await repo.filaments.get(filamentId)
  if (!filament.ok)
    return filament.reason === 'not-found'
      ? message(404, notFound('filament', filamentId))
      : filament

  let spoolWeight = (v.spool_weight ?? null) as number | null
  if (spoolWeight === null && filament.value.spoolWeight !== null)
    spoolWeight = filament.value.spoolWeight

  let initialWeight = (v.initial_weight ?? null) as number | null
  if (initialWeight === null && filament.value.weight !== null)
    initialWeight = filament.value.weight

  if (usedWeight === null) {
    if (remainingWeight !== null) {
      if (initialWeight === null || initialWeight === 0)
        return message(
          400,
          'Failed to create spool, see server logs for more information.',
        )
      usedWeight = Math.max(initialWeight - remainingWeight, 0)
    } else {
      usedWeight = 0
    }
  }

  const input: SpoolInput = {
    filamentId,
    initialWeight,
    spoolWeight,
    usedWeight,
    price: (v.price ?? null) as number | null,
    location: (v.location ?? null) as string | null,
    lotNr: (v.lot_nr ?? null) as string | null,
    comment: (v.comment ?? null) as string | null,
    archived: (v.archived ?? false) as boolean,
    firstUsedAt: (v.first_used ?? null) as number | null,
    lastUsedAt: (v.last_used ?? null) as number | null,
    extra: mergeExtra({}, extra ?? {}),
  }
  const created = await repo.spools.create(input)
  return created.ok
    ? hydrateSpool(repo, created.value, filament.value)
    : created
}

async function update(
  repo: SpoolLibraryRepository,
  rawId: string,
  request: LegacyApiRequest,
): Promise<LegacyModuleResult> {
  const id = pathInt('spool_id', rawId)
  const parsed = parseSpoolBody(request, true, id.ok ? [] : [id.issue])
  if ('issues' in parsed || !id.ok)
    return unprocessable(('issues' in parsed && parsed.issues) || [])
  const v = parsed.values
  const set = parsed.set
  if (
    v.remaining_weight !== undefined &&
    v.remaining_weight !== null &&
    v.used_weight !== undefined &&
    v.used_weight !== null
  )
    return message(400, 'Only specify either remaining_weight or used_weight.')
  const extra = (v.extra ?? null) as Record<string, string | null> | null
  const extraFailure = await extraError(repo, extra)
  if (extraFailure) return extraFailure

  const current = await repo.spools.get(id.value)
  if (!current.ok)
    return current.reason === 'not-found'
      ? message(404, notFound('spool', id.value))
      : current

  const patch: Partial<SpoolInput> = {}
  let effInitialWeight = current.value.initialWeight
  let loadedFilament: SpoolFilament | undefined

  // Apply fields in upstream SpoolParameters declaration order.
  if (set.has('first_used')) patch.firstUsedAt = v.first_used as number | null
  if (set.has('last_used')) patch.lastUsedAt = v.last_used as number | null
  if (set.has('filament_id')) {
    const filamentId = v.filament_id as number
    const filament = await repo.filaments.get(filamentId)
    if (!filament.ok)
      return filament.reason === 'not-found'
        ? message(404, notFound('filament', filamentId))
        : filament
    loadedFilament = filament.value
    patch.filamentId = filamentId
    if (effInitialWeight === null && filament.value.weight !== null) {
      effInitialWeight = filament.value.weight
      patch.initialWeight = filament.value.weight
    }
  }
  if (set.has('price')) patch.price = v.price as number | null
  if (set.has('initial_weight')) {
    effInitialWeight = v.initial_weight as number | null
    patch.initialWeight = effInitialWeight
  }
  if (set.has('spool_weight'))
    patch.spoolWeight = v.spool_weight as number | null
  if (set.has('remaining_weight') && v.remaining_weight !== null) {
    if (effInitialWeight === null)
      return message(
        400,
        'Failed to update spool, see server logs for more information.',
      )
    patch.usedWeight = Math.max(
      effInitialWeight - (v.remaining_weight as number),
      0,
    )
  }
  if (set.has('used_weight') && v.used_weight !== null)
    patch.usedWeight = v.used_weight as number
  if (set.has('location')) patch.location = v.location as string | null
  if (set.has('lot_nr')) patch.lotNr = v.lot_nr as string | null
  if (set.has('comment')) patch.comment = v.comment as string | null
  if (set.has('archived')) patch.archived = v.archived as boolean
  if (extra) patch.extra = mergeExtra(current.value.extra, extra)

  const updated = await repo.spools.update(id.value, patch)
  return updated.ok
    ? hydrateSpool(repo, updated.value, loadedFilament)
    : updated
}

async function remove(
  repo: SpoolLibraryRepository,
  rawId: string,
): Promise<LegacyModuleResult> {
  const id = pathInt('spool_id', rawId)
  if (!id.ok) return unprocessable([id.issue])
  const deleted = await repo.spools.delete(id.value)
  if (deleted.ok) return message(200, 'Success!')
  if (deleted.reason === 'not-found')
    return message(404, notFound('spool', id.value))
  return deleted
}

async function use(
  repo: SpoolLibraryRepository,
  rawId: string,
  request: LegacyApiRequest,
): Promise<LegacyModuleResult> {
  const id = pathInt('spool_id', rawId)
  const body = checkBody(request.body, USE_FIELDS)
  const prefix = id.ok ? [] : [id.issue]
  if (!body.ok || !id.ok) return unprocessable([...prefix, ...body.issues])
  const useWeight = (body.values.use_weight ?? null) as number | null
  const useLength = (body.values.use_length ?? null) as number | null
  if (useWeight !== null && useLength !== null)
    return message(400, 'Only specify either use_weight or use_length.')
  if (useWeight !== null) {
    const updated = await repo.spools.use(id.value, useWeight)
    if (!updated.ok)
      return updated.reason === 'not-found'
        ? message(404, notFound('spool', id.value))
        : updated
    return hydrateSpool(repo, updated.value)
  }
  if (useLength !== null) {
    const spool = await repo.spools.get(id.value)
    if (!spool.ok)
      return spool.reason === 'not-found'
        ? message(404, 'Filament not found for spool.')
        : spool
    const filament = await repo.filaments.get(spool.value.filamentId)
    if (!filament.ok)
      return filament.reason === 'not-found'
        ? message(404, 'Filament not found for spool.')
        : filament
    const grams = weightFromLength(
      useLength,
      filament.value.diameter,
      filament.value.density,
    )
    const updated = await repo.spools.use(id.value, grams)
    return updated.ok
      ? hydrateSpool(repo, updated.value, filament.value)
      : updated
  }
  return message(400, 'Either use_weight or use_length must be specified.')
}

async function measure(
  repo: SpoolLibraryRepository,
  rawId: string,
  request: LegacyApiRequest,
): Promise<LegacyModuleResult> {
  const id = pathInt('spool_id', rawId)
  const body = checkBody(request.body, MEASURE_FIELDS)
  const prefix = id.ok ? [] : [id.issue]
  if (!body.ok || !id.ok) return unprocessable([...prefix, ...body.issues])
  const weight = body.values.weight as number

  const spool = await repo.spools.get(id.value)
  if (!spool.ok)
    return spool.reason === 'not-found'
      ? message(400, 'Spool not found.')
      : spool

  const filament = await repo.filaments.get(spool.value.filamentId)
  if (!filament.ok)
    return filament.reason === 'not-found'
      ? message(404, 'Filament not found for spool.')
      : filament

  let vendor: SpoolVendor | null = null
  if (filament.value.vendorId !== null) {
    const fetched = await repo.vendors.get(filament.value.vendorId)
    if (!fetched.ok) return fetched
    vendor = fetched.value
  }

  let initialWeight = spool.value.initialWeight
  let spoolWeight = spool.value.spoolWeight
  if (initialWeight === null || initialWeight === 0 || spoolWeight === null) {
    if (spoolWeight === null)
      spoolWeight =
        filament.value.spoolWeight !== null
          ? filament.value.spoolWeight
          : (vendor?.emptySpoolWeight ?? null)
    if (initialWeight === null || initialWeight === 0)
      initialWeight = filament.value.weight !== null ? filament.value.weight : 0
  }

  if (initialWeight === null || initialWeight === 0)
    return message(400, 'Initial weight is not set.')
  if (spoolWeight === null) spoolWeight = 0

  const initialGrossWeight = initialWeight + spoolWeight
  if (weight > initialGrossWeight) {
    const updated = await repo.spools.update(id.value, {
      initialWeight: weight - spoolWeight,
      usedWeight: 0,
    })
    return updated.ok
      ? hydrateSpool(repo, updated.value, filament.value, vendor)
      : updated
  }

  const currentUse = initialGrossWeight - spool.value.usedWeight
  let weightToUse = currentUse - weight
  if (initialGrossWeight - weightToUse < spoolWeight)
    weightToUse = currentUse - spoolWeight
  const updated = await repo.spools.use(id.value, weightToUse)
  return updated.ok
    ? hydrateSpool(repo, updated.value, filament.value, vendor)
    : updated
}

export const spoolModule: LegacyApiModule = {
  name: 'spool',
  async handle(repo, request) {
    const match = /^\/api\/v1\/spool(?:\/([^/]+)(?:\/(use|measure))?)?$/.exec(
      request.apiPath,
    )
    if (!match) return undefined
    const rawId = match[1]
    const action = match[2]
    // Leave `/api/v1/spool/group` unclaimed for the sibling group module.
    if (rawId === 'group' && action === undefined) return undefined
    const allowed =
      rawId === undefined
        ? ['GET', 'POST']
        : action === undefined
          ? ['GET', 'PATCH', 'DELETE']
          : ['PUT']
    if (!allowed.includes(request.method)) return methodNotAllowed()
    if (MUTATING.has(request.method) && repo.access === 'read')
      return failure('denied')
    if (rawId === undefined)
      return request.method === 'GET'
        ? find(repo, request.query)
        : create(repo, request)
    if (action === 'use') return use(repo, rawId, request)
    if (action === 'measure') return measure(repo, rawId, request)
    if (request.method === 'GET') return get(repo, rawId)
    if (request.method === 'PATCH') return update(repo, rawId, request)
    return remove(repo, rawId)
  },
}
