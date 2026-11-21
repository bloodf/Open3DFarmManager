/**
 * `/api/v1/vendor` and `/api/v1/vendor/{vendor_id}` of the pinned Spoolman
 * v0.27.1 (`spoolman/api/v1/vendor.py`), bound to one farm. Websocket
 * listeners on the same paths are not served over this HTTP bridge.
 */
import type {
  SpoolLibraryRepository,
  SpoolVendor,
  SpoolVendorInput,
} from '../scope.ts'
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
import { loadAll, notFound, vendorJson } from './records.ts'
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
  asInt,
  byFieldOrder,
  checkBody,
  pathInt,
  unprocessable,
  valueError,
  type FieldSpec,
  type Issue,
} from './validation.ts'

export const VENDOR_MODEL: Model<SpoolVendor> = {
  name: 'Vendor',
  columns: {
    id: (v) => v.id,
    registered: (v) => Math.floor(v.registeredAt / 1000),
    name: (v) => v.name,
    empty_spool_weight: (v) => v.emptySpoolWeight,
    comment: (v) => v.comment,
    external_id: (v) => v.externalId,
  },
}

const FIELDS = (update: boolean): [string, FieldSpec][] => [
  ['name', { kind: 'str', max: 64, required: !update }],
  ['comment', { kind: 'str', max: 1024 }],
  ['empty_spool_weight', { kind: 'float', ge: 0 }],
  ['external_id', { kind: 'str', max: 256 }],
  ['extra', { kind: 'extra' }],
]

/** Shared limit/offset query validation (FastAPI 422 before the handler runs). */
export function pageQuery(query: URLSearchParams, issues: Issue[]) {
  const rawLimit = lastQueryValue(query, 'limit')
  const rawOffset = lastQueryValue(query, 'offset')
  let limit: number | null = null
  let offset = 0
  if (rawLimit !== null) {
    const n = asInt(['query', 'limit'], rawLimit)
    if (n.ok) limit = n.value
    else issues.push(n.issue)
  }
  if (rawOffset !== null) {
    const n = asInt(['query', 'offset'], rawOffset)
    if (n.ok) offset = n.value
    else issues.push(n.issue)
  }
  return { limit, offset }
}

async function find(
  repo: SpoolLibraryRepository,
  query: URLSearchParams,
): Promise<LegacyModuleResult> {
  const issues: Issue[] = []
  const { limit, offset } = pageQuery(query, issues)
  if (issues.length) return unprocessable(issues)
  const sort = parseSort(lastQueryValue(query, 'sort'))
  if (typeof sort === 'string') return message(400, sort)
  const rows = await loadAll((page) => repo.vendors.list(page))
  if (!rows.ok) return rows
  const fields = await repo.extraFields.list('vendor')
  if (!fields.ok) return fields
  const byName = stringFilter(lastQueryValue(query, 'name'), false)
  const byExternal = stringFilter(lastQueryValue(query, 'external_id'), true)
  let extraFilters
  try {
    extraFilters = compileExtraFilters(fields.value, extraQueryFilters(query))
  } catch (error) {
    return message(400, (error as Error).message)
  }
  const keys = sortKeys(VENDOR_MODEL, sort, fields.value)
  if (typeof keys === 'string') return message(400, keys)
  const matched = rows.value.filter(
    (v) =>
      (!byName || byName(v.name)) &&
      (!byExternal || byExternal(v.externalId)) &&
      extraFilters.every((match) => match(v.extra)),
  )
  const { page, total } = paginate(sortRows(matched, keys), limit, offset)
  return respond(200, page.map(vendorJson), { 'x-total-count': String(total) })
}

function toInput(values: Record<string, unknown>, set: Set<string>) {
  const input: Partial<SpoolVendorInput> = {}
  if (set.has('name')) input.name = values.name as string
  if (set.has('comment')) input.comment = values.comment as string | null
  if (set.has('empty_spool_weight'))
    input.emptySpoolWeight = values.empty_spool_weight as number | null
  if (set.has('external_id'))
    input.externalId = values.external_id as string | null
  return input
}

async function create(
  repo: SpoolLibraryRepository,
  request: LegacyApiRequest,
): Promise<LegacyModuleResult> {
  const body = checkBody(request.body, FIELDS(false))
  if (!body.ok) return unprocessable(body.issues)
  const extra = (body.values.extra ?? null) as Record<
    string,
    string | null
  > | null
  if (extra && Object.keys(extra).length) {
    const fields = await repo.extraFields.list('vendor')
    if (!fields.ok) return fields
    const error = extraDictError(fields.value, extra)
    if (error) return message(400, error)
  }
  const created = await repo.vendors.create({
    ...(toInput(body.values, body.set) as SpoolVendorInput),
    extra: mergeExtra({}, extra ?? {}),
  })
  return created.ok ? respond(200, vendorJson(created.value)) : created
}

async function update(
  repo: SpoolLibraryRepository,
  rawId: string,
  request: LegacyApiRequest,
): Promise<LegacyModuleResult> {
  const id = pathInt('vendor_id', rawId)
  const body = checkBody(request.body, FIELDS(true))
  const bodyIssues = [...body.issues]
  if (body.set.has('name') && body.values.name === null)
    bodyIssues.push(
      valueError(['body', 'name'], null, 'Value must not be None.'),
    )
  const issues: Issue[] = [
    ...(id.ok ? [] : [id.issue]),
    ...byFieldOrder(bodyIssues, FIELDS(true)),
  ]
  if (issues.length || !id.ok) return unprocessable(issues)
  const extra = (body.values.extra ?? null) as Record<
    string,
    string | null
  > | null
  if (extra && Object.keys(extra).length) {
    const fields = await repo.extraFields.list('vendor')
    if (!fields.ok) return fields
    const error = extraDictError(fields.value, extra)
    if (error) return message(400, error)
  }
  const current = await repo.vendors.get(id.value)
  if (!current.ok)
    return current.reason === 'not-found'
      ? message(404, notFound('vendor', id.value))
      : current
  const patch = toInput(body.values, body.set)
  if (body.set.has('extra') && extra)
    patch.extra = mergeExtra(current.value.extra, extra)
  const updated = await repo.vendors.update(id.value, patch)
  return updated.ok ? respond(200, vendorJson(updated.value)) : updated
}

async function remove(
  repo: SpoolLibraryRepository,
  rawId: string,
): Promise<LegacyModuleResult> {
  const id = pathInt('vendor_id', rawId)
  if (!id.ok) return unprocessable([id.issue])
  const deleted = await repo.vendors.delete(id.value)
  if (deleted.ok) return message(200, 'Success!')
  return deleted.reason === 'not-found'
    ? message(404, notFound('vendor', id.value))
    : deleted
}

async function get(
  repo: SpoolLibraryRepository,
  rawId: string,
): Promise<LegacyModuleResult> {
  const id = pathInt('vendor_id', rawId)
  if (!id.ok) return unprocessable([id.issue])
  const vendor = await repo.vendors.get(id.value)
  if (vendor.ok) return respond(200, vendorJson(vendor.value))
  return vendor.reason === 'not-found'
    ? message(404, notFound('vendor', id.value))
    : vendor
}

export const vendorModule: LegacyApiModule = {
  name: 'vendor',
  async handle(repo, request) {
    const match = /^\/api\/v1\/vendor(?:\/([^/]+))?$/.exec(request.apiPath)
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
