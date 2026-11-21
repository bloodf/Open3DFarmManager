/**
 * Find-endpoint plumbing shared by vendor and filament (and later spool):
 * upstream `parse_sort`, `parse_nested_field`, string filters, NULLS-last
 * ordering, limit/offset and the x-total-count value.
 */
import type { SpoolExtraFieldDefinition } from '../scope.ts'
import { compareText, sqliteLike, splitFilterTerms } from './compat.ts'
import { extraSortValue } from './extra-fields.ts'

export type Direction = 'asc' | 'desc'

/** Upstream `parse_sort`; a string is the 400 message. */
export function parseSort(
  sort: string | null,
): Map<string, Direction> | string {
  const out = new Map<string, Direction>()
  if (sort === null) return out
  for (const raw of sort.split(',')) {
    const item = raw.trim()
    if (!item) continue
    const colon = item.indexOf(':')
    if (colon === -1)
      return `Invalid sort '${item}', expected the form 'field:asc' or 'field:desc'.`
    const field = item.slice(0, colon)
    const direction = item.slice(colon + 1)
    if (!field) return `Invalid sort '${item}', no field name was given.`
    const normalized = direction.trim().toUpperCase()
    if (normalized !== 'ASC' && normalized !== 'DESC')
      return `Invalid sort direction '${direction}' for field '${field}', expected 'asc' or 'desc'.`
    out.set(field, normalized === 'ASC' ? 'asc' : 'desc')
  }
  return out
}

/** A sortable model: its mapped columns and the relations it can traverse. */
export interface Model<T> {
  name: string
  columns: Record<string, (row: T) => unknown>
  relations?: Record<string, { model: Model<never>; get: (row: T) => unknown }>
}

/** Upstream `parse_nested_field`; a string is the 400 message. */
export function resolveColumn<T>(
  model: Model<T>,
  path: string,
): ((row: T) => unknown) | string {
  const parts = path.split('.')
  const head = parts[0]!
  const relation = model.relations?.[head]
  if (relation) {
    if (parts.length === 1) return `No field specified for ${head}`
    const inner = resolveColumn(
      relation.model as Model<unknown>,
      parts.slice(1).join('.'),
    )
    if (typeof inner === 'string') return inner
    return (row) => {
      const related = relation.get(row)
      return related === null || related === undefined ? null : inner(related)
    }
  }
  if (!Object.hasOwn(model.columns, head))
    return `Invalid field name '${path}', '${head}' is not a valid field on '${model.name}'.`
  if (parts.length > 1) return `Field '${head}' does not have any nested fields`
  return model.columns[head]!
}

/** Upstream `add_where_clause_str` (`optional` = `_str_opt`). */
export function stringFilter(
  value: string | null,
  optional: boolean,
): ((field: string | null | undefined) => boolean) | null {
  if (value === null) return null
  const terms = splitFilterTerms(value)
  return (field) =>
    terms.some((term) => {
      if (term.length === 0)
        return optional
          ? field === null || field === undefined || field === ''
          : field === ''
      if (field === null || field === undefined) return false
      if (term[0] === '"' && term.at(-1) === '"')
        return field === term.slice(1, -1)
      return sqliteLike(field, `%${term}%`)
    })
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return compareText(a, b)
  if (typeof a === 'boolean' && typeof b === 'boolean')
    return Number(a) - Number(b)
  return compareText(String(a), String(b))
}

type Key<T> = { get: (row: T) => unknown; direction: Direction }

/**
 * Upstream order: registered `extra.*` sort keys first (unknown ones are
 * ignored), then the built-in columns, each with NULLs last. The input order
 * (ascending id) breaks ties.
 */
export function sortKeys<T extends { extra: Record<string, unknown> }>(
  model: Model<T>,
  sort: Map<string, Direction>,
  fields: readonly SpoolExtraFieldDefinition[],
): Key<T>[] | string {
  const keys: Key<T>[] = []
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
    const get = resolveColumn(model, name)
    if (typeof get === 'string') return get
    keys.push({ get, direction })
  }
  return keys
}

export function sortRows<T>(rows: readonly T[], keys: readonly Key<T>[]): T[] {
  return [...rows].sort((x, y) => {
    for (const key of keys) {
      const a = key.get(x)
      const b = key.get(y)
      const aNull = a === null || a === undefined
      const bNull = b === null || b === undefined
      if (aNull || bNull) {
        if (aNull !== bNull) return aNull ? 1 : -1
        continue
      }
      const d = compareValues(a, b)
      if (d !== 0) return key.direction === 'asc' ? d : -d
    }
    return 0
  })
}

/** Upstream limit/offset: offset only applies with a limit; negatives as SQLite. */
export function paginate<T>(
  rows: readonly T[],
  limit: number | null,
  offset: number,
): { page: T[]; total: number } {
  if (limit === null) return { page: [...rows], total: rows.length }
  const start = Math.max(0, offset)
  const page = limit < 0 ? rows.slice(start) : rows.slice(start, start + limit)
  return { page, total: rows.length }
}
