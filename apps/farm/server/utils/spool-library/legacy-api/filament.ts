/**
 * `/api/v1/filament` and `/api/v1/filament/{filament_id}` of the pinned
 * Spoolman v0.27.1 (`spoolman/api/v1/filament.py`), bound to one farm.
 * Tag link/unlink (`/filament/{id}/tag...`) belongs to the tag module.
 */
import type {
  SpoolFilament,
  SpoolFilamentInput,
  SpoolLibraryRepository,
  SpoolVendor,
} from '../scope.ts'
import { normalizeUid, similarColorIds } from './color.ts'
import {
  compileExtraFilters,
  extraDictError,
  mergeExtra,
} from './extra-fields.ts'
import {
  paginate,
  parseSort,
  sortKeys,
  sortRows,
  stringFilter,
  type Model,
} from './listing.ts'
import { filamentJson, loadAll, notFound } from './records.ts'
import {
  MUTATING,
  extraQueryFilters,
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
  asFloat,
  byFieldOrder,
  checkBody,
  pathInt,
  unprocessable,
  valueError,
  type FieldSpec,
  type Issue,
} from './validation.ts'
import { VENDOR_MODEL, pageQuery } from './vendor.ts'

type Row = SpoolFilament & { vendor: SpoolVendor | null }

export const FILAMENT_MODEL: Model<Row> = {
  name: 'Filament',
  columns: {
    id: (f) => f.id,
    registered: (f) => Math.floor(f.registeredAt / 1000),
    name: (f) => f.name,
    vendor_id: (f) => f.vendorId,
    material: (f) => f.material,
    price: (f) => f.price,
    density: (f) => f.density,
    diameter: (f) => f.diameter,
    weight: (f) => f.weight,
    spool_weight: (f) => f.spoolWeight,
    article_number: (f) => f.articleNumber,
    comment: (f) => f.comment,
    settings_extruder_temp: (f) => f.settingsExtruderTemp,
    settings_bed_temp: (f) => f.settingsBedTemp,
    color_hex: (f) => f.colorHex,
    multi_color_hexes: (f) => f.multiColorHexes,
    multi_color_direction: (f) => f.multiColorDirection,
    external_id: (f) => f.externalId,
  },
  relations: {
    vendor: { model: VENDOR_MODEL as Model<never>, get: (f) => f.vendor },
  },
}

const FIELDS = (update: boolean): [string, FieldSpec][] => [
  ['name', { kind: 'str', max: 64 }],
  ['vendor_id', { kind: 'int' }],
  ['material', { kind: 'str', max: 64 }],
  ['price', { kind: 'float', ge: 0 }],
  ['density', { kind: 'float', gt: 0, required: !update }],
  ['diameter', { kind: 'float', gt: 0, required: !update }],
  ['weight', { kind: 'float', gt: 0 }],
  ['spool_weight', { kind: 'float', ge: 0 }],
  ['article_number', { kind: 'str', max: 64 }],
  ['comment', { kind: 'str', max: 1024 }],
  ['settings_extruder_temp', { kind: 'int', ge: 0 }],
  ['settings_bed_temp', { kind: 'int', ge: 0 }],
  ['color_hex', { kind: 'str' }],
  ['multi_color_hexes', { kind: 'str' }],
  [
    'multi_color_direction',
    { kind: 'enum', values: ['coaxial', 'longitudinal'] },
  ],
  ['external_id', { kind: 'str', max: 256 }],
  ['extra', { kind: 'extra' }],
]

/** One color code check; returns the upstream error text or the stored form. */
function colorCode(raw: string): { error: string } | { value: string } {
  const code = raw.toUpperCase().replace(/^#/, '')
  if (![...code].every((c) => '0123456789ABCDEF'.includes(c)))
    return { error: 'Invalid character in color code.' }
  if (code.length !== 6 && code.length !== 8)
    return { error: 'Color code must be 6 or 8 characters long.' }
  return { value: raw.replace(/^#/, '') }
}

/** Field validators of `FilamentParameters` (run on fields that passed their type check). */
function fieldRules(
  values: Record<string, unknown>,
  set: Set<string>,
  update: boolean,
) {
  const issues: Issue[] = []
  const out = { ...values }
  if (typeof values.color_hex === 'string') {
    const input = values.color_hex
    const checked = input ? colorCode(input) : { value: null }
    if ('error' in checked)
      issues.push(valueError(['body', 'color_hex'], input, checked.error))
    else out.color_hex = checked.value
  }
  if (typeof values.multi_color_hexes === 'string') {
    const input = values.multi_color_hexes
    const colors: string[] = []
    for (const part of input ? input.split(',') : []) {
      const checked = colorCode(part)
      if ('error' in checked) {
        issues.push(
          valueError(['body', 'multi_color_hexes'], input, checked.error),
        )
        break
      }
      colors.push(checked.value)
    }
    out.multi_color_hexes = input ? colors.join(',') : null
  }
  if (update)
    for (const name of ['density', 'diameter'])
      if (set.has(name) && values[name] === null)
        issues.push(valueError(['body', name], null, 'Value must not be None.'))
  return { issues, values: out }
}

/** The `@model_validator(mode="after")` of `FilamentParameters`. */
function modelRules(values: Record<string, unknown>, input: unknown): Issue[] {
  const color = values.color_hex
  const multi = values.multi_color_hexes as string | null | undefined
  const direction = values.multi_color_direction
  const fail = (text: string) => [valueError(['body'], input, text)]
  if (color && multi)
    return fail('Cannot specify both color_hex and multi_color_hexes.')
  if (multi && multi.split(',').length < 2)
    return fail('Must specify at least two colors in multi_color_hexes.')
  if (multi && !direction)
    return fail('Multi-color filament must have multi_color_direction set.')
  if (!multi && direction)
    return fail(
      'Single-color filament must not have multi_color_direction set.',
    )
  return []
}

const COLUMN: Record<string, keyof SpoolFilamentInput> = {
  name: 'name',
  vendor_id: 'vendorId',
  material: 'material',
  price: 'price',
  density: 'density',
  diameter: 'diameter',
  weight: 'weight',
  spool_weight: 'spoolWeight',
  article_number: 'articleNumber',
  comment: 'comment',
  settings_extruder_temp: 'settingsExtruderTemp',
  settings_bed_temp: 'settingsBedTemp',
  color_hex: 'colorHex',
  multi_color_hexes: 'multiColorHexes',
  multi_color_direction: 'multiColorDirection',
  external_id: 'externalId',
}

function parse(request: LegacyApiRequest, update: boolean, prefix: Issue[]) {
  const fields = FIELDS(update)
  const body = checkBody(request.body, fields)
  if (body.fatal) return { issues: [...prefix, ...body.issues] }
  const rules = fieldRules(body.values, body.set, update)
  const fieldIssues = byFieldOrder([...body.issues, ...rules.issues], fields)
  if (fieldIssues.length) return { issues: [...prefix, ...fieldIssues] }
  const raw = request.body.kind === 'json' ? request.body.value : undefined
  const modelIssues = modelRules(rules.values, raw)
  if (prefix.length || modelIssues.length)
    return { issues: [...prefix, ...modelIssues] }
  const input: Record<string, unknown> = {}
  for (const [name, column] of Object.entries(COLUMN))
    if (body.set.has(name)) input[column] = rules.values[name]
  const extra = (body.values.extra ?? null) as Record<
    string,
    string | null
  > | null
  return { input: input as Partial<SpoolFilamentInput>, extra }
}

async function extraError(
  repo: SpoolLibraryRepository,
  extra: Record<string, string | null> | null,
) {
  if (!extra || !Object.keys(extra).length) return null
  const fields = await repo.extraFields.list('filament')
  if (!fields.ok) return fields
  const error = extraDictError(fields.value, extra)
  return error ? message(400, error) : null
}

async function withVendor(
  repo: SpoolLibraryRepository,
  filament: SpoolFilament,
) {
  if (filament.vendorId === null) return { ok: true as const, value: null }
  return repo.vendors.get(filament.vendorId)
}

async function respondFilament(
  repo: SpoolLibraryRepository,
  filament: SpoolFilament,
): Promise<LegacyModuleResult> {
  const vendor = await withVendor(repo, filament)
  return vendor.ok ? respond(200, filamentJson(filament, vendor.value)) : vendor
}

export const ID_LIST = /^-?\d+(,-?\d+)*$/
export const patternIssue = (name: string, input: string): Issue => ({
  type: 'string_pattern_mismatch',
  loc: ['query', name],
  msg: `String should match pattern '${ID_LIST.source}'`,
  input,
  ctx: { pattern: ID_LIST.source },
})

async function find(
  repo: SpoolLibraryRepository,
  query: URLSearchParams,
): Promise<LegacyModuleResult> {
  const issues: Issue[] = []
  const q = (key: string) => lastQueryValue(query, key)
  for (const key of ['vendor_id', 'vendor.id']) {
    const value = q(key)
    if (value !== null && !ID_LIST.test(value))
      issues.push(patternIssue(key, value))
  }
  let threshold = 20
  const rawThreshold = q('color_similarity_threshold')
  if (rawThreshold !== null) {
    const n = asFloat(['query', 'color_similarity_threshold'], rawThreshold)
    if (n.ok) threshold = n.value
    else issues.push(n.issue)
  }
  const { limit, offset } = pageQuery(query, issues)
  if (issues.length) return unprocessable(issues)
  const sort = parseSort(q('sort'))
  if (typeof sort === 'string') return message(400, sort)
  const vendorIdsRaw = q('vendor.id') ?? q('vendor_id')
  const vendorIds =
    vendorIdsRaw === null ? null : vendorIdsRaw.split(',').map(Number)
  const filaments = await loadAll((page) => repo.filaments.list(page))
  if (!filaments.ok) return filaments
  const vendors = await loadAll((page) => repo.vendors.list(page))
  if (!vendors.ok) return vendors
  const vendorById = new Map(vendors.value.map((v) => [v.id, v]))
  const rows: Row[] = filaments.value.map((f) => ({
    ...f,
    vendor: f.vendorId === null ? null : (vendorById.get(f.vendorId) ?? null),
  }))
  const color = q('color_hex')
  const colorIds =
    color === null ? null : similarColorIds(rows, color, threshold)
  if (color !== null && colorIds === null)
    return respond(500, 'Internal Server Error')
  const fields = await repo.extraFields.list('filament')
  if (!fields.ok) return fields
  const byVendorName = stringFilter(q('vendor.name') ?? q('vendor_name'), false)
  const byName = stringFilter(q('name'), true)
  const byMaterial = stringFilter(q('material'), true)
  const byArticle = stringFilter(q('article_number'), true)
  const byExternal = stringFilter(q('external_id'), true)
  const tag = q('tag')
  if (tag !== null) {
    const normalized = normalizeUid(tag)
    if ('error' in normalized) return message(400, normalized.error)
  }
  let extraFilters
  try {
    extraFilters = compileExtraFilters(fields.value, extraQueryFilters(query))
  } catch (error) {
    return message(400, (error as Error).message)
  }
  const keys = sortKeys(FILAMENT_MODEL, sort, fields.value)
  if (typeof keys === 'string') return message(400, keys)
  const matched = rows.filter(
    (f) =>
      (!colorIds || colorIds.has(f.id)) &&
      (!vendorIds ||
        vendorIds.some((id) =>
          id === -1 ? f.vendorId === null : f.vendorId === id,
        )) &&
      (!byVendorName || byVendorName(f.vendor?.name)) &&
      (!byName || byName(f.name)) &&
      (!byMaterial || byMaterial(f.material)) &&
      (!byArticle || byArticle(f.articleNumber)) &&
      (!byExternal || byExternal(f.externalId)) &&
      // No tag is linked to a filament until the tag module exists.
      tag === null &&
      extraFilters.every((match) => match(f.extra)),
  )
  const { page, total } = paginate(sortRows(matched, keys), limit, offset)
  return respond(
    200,
    page.map((f) => filamentJson(f, f.vendor)),
    { 'x-total-count': String(total) },
  )
}

async function create(
  repo: SpoolLibraryRepository,
  request: LegacyApiRequest,
): Promise<LegacyModuleResult> {
  const parsed = parse(request, false, [])
  if ('issues' in parsed) return unprocessable(parsed.issues!)
  const extraFailure = await extraError(repo, parsed.extra)
  if (extraFailure) return extraFailure
  const input = { ...parsed.input } as SpoolFilamentInput
  if (input.vendorId !== undefined && input.vendorId !== null) {
    const vendor = await repo.vendors.get(input.vendorId)
    if (!vendor.ok)
      return vendor.reason === 'not-found'
        ? message(404, notFound('vendor', input.vendorId))
        : vendor
    if (
      (input.spoolWeight ?? null) === null &&
      vendor.value.emptySpoolWeight !== null
    )
      input.spoolWeight = vendor.value.emptySpoolWeight
  }
  const created = await repo.filaments.create({
    ...input,
    extra: mergeExtra({}, parsed.extra ?? {}),
  })
  return created.ok ? respondFilament(repo, created.value) : created
}

async function update(
  repo: SpoolLibraryRepository,
  rawId: string,
  request: LegacyApiRequest,
): Promise<LegacyModuleResult> {
  const id = pathInt('filament_id', rawId)
  const parsed = parse(request, true, id.ok ? [] : [id.issue])
  if ('issues' in parsed || !id.ok)
    return unprocessable(('issues' in parsed && parsed.issues) || [])
  const extraFailure = await extraError(repo, parsed.extra)
  if (extraFailure) return extraFailure
  const current = await repo.filaments.get(id.value)
  if (!current.ok)
    return current.reason === 'not-found'
      ? message(404, notFound('filament', id.value))
      : current
  const patch = { ...parsed.input }
  if (patch.vendorId !== undefined && patch.vendorId !== null) {
    const vendor = await repo.vendors.get(patch.vendorId)
    if (!vendor.ok)
      return vendor.reason === 'not-found'
        ? message(404, notFound('vendor', patch.vendorId))
        : vendor
  }
  if (parsed.extra) patch.extra = mergeExtra(current.value.extra, parsed.extra)
  const updated = await repo.filaments.update(id.value, patch)
  return updated.ok ? respondFilament(repo, updated.value) : updated
}

async function remove(
  repo: SpoolLibraryRepository,
  rawId: string,
): Promise<LegacyModuleResult> {
  const id = pathInt('filament_id', rawId)
  if (!id.ok) return unprocessable([id.issue])
  const deleted = await repo.filaments.delete(id.value)
  if (deleted.ok) return message(200, 'Success!')
  if (deleted.reason === 'not-found')
    return message(404, notFound('filament', id.value))
  // A spool still refers to it: upstream's IntegrityError answer.
  if (deleted.reason === 'conflict')
    return message(
      403,
      'Failed to delete filament, see server logs for more information.',
    )
  return deleted
}

async function get(
  repo: SpoolLibraryRepository,
  rawId: string,
): Promise<LegacyModuleResult> {
  const id = pathInt('filament_id', rawId)
  if (!id.ok) return unprocessable([id.issue])
  const filament = await repo.filaments.get(id.value)
  if (filament.ok) return respondFilament(repo, filament.value)
  return filament.reason === 'not-found'
    ? message(404, notFound('filament', id.value))
    : filament
}

export const filamentModule: LegacyApiModule = {
  name: 'filament',
  async handle(repo, request) {
    const match = /^\/api\/v1\/filament(?:\/([^/]+))?$/.exec(request.apiPath)
    if (!match) return undefined
    const rawId = match[1]
    const allowed =
      rawId === undefined ? ['GET', 'POST'] : ['GET', 'PATCH', 'DELETE']
    if (!allowed.includes(request.method)) return methodNotAllowed()
    if (MUTATING.has(request.method) && repo.access === 'read')
      return failure('denied')
    if (rawId === undefined)
      return request.method === 'GET'
        ? find(repo, request.query)
        : create(repo, request)
    if (request.method === 'GET') return get(repo, rawId)
    if (request.method === 'PATCH') return update(repo, rawId, request)
    return remove(repo, rawId)
  },
}
