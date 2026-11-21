/**
 * Extra fields as in upstream `extra_field_registry` / `extra_field_query`.
 * Values are JSON-encoded strings; definitions come from the farm's registry.
 */
import type { SpoolExtraFieldDefinition } from '../scope.ts'
import {
  escapeLike,
  pyFloat,
  pyInt,
  pyLen,
  pyRepr,
  sqliteCastInteger,
  sqliteCastReal,
  sqliteLike,
  splitFilterTerms,
} from './compat.ts'

const MAX_VALUE_LENGTH = 2 ** 16 - 1

type Json = unknown
const isInt = (v: Json) => typeof v === 'number' && Number.isInteger(v)
const isNum = (v: Json) => typeof v === 'number'

/** Python `json.loads` acceptance; `undefined` when it would raise. */
function parseJson(text: string): { value: Json } | undefined {
  try {
    return { value: JSON.parse(text) }
  } catch {
    // Python also accepts NaN / Infinity literals.
    if (/^\s*-?(NaN|Infinity)\s*$/.test(text)) return { value: Number.NaN }
    return undefined
  }
}

/** Upstream `validate_extra_field_value`; returns the error text or null. */
export function extraValueError(
  field: SpoolExtraFieldDefinition,
  value: string,
): string | null {
  if (pyLen(value) > MAX_VALUE_LENGTH)
    return `Value is too big, max size is ${MAX_VALUE_LENGTH} characters.`
  const parsed = parseJson(value)
  if (!parsed) return 'Value is not valid JSON.'
  const data = parsed.value
  switch (field.fieldType) {
    case 'text':
    case 'datetime':
      return typeof data === 'string' ? null : 'Value is not a string.'
    case 'integer':
      return isInt(data) && !Number.isNaN(data)
        ? null
        : 'Value is not an integer.'
    case 'float':
      return isNum(data) ? null : 'Value is not a float.'
    case 'integer_range':
    case 'float_range': {
      if (!Array.isArray(data)) return 'Value is not a list.'
      if (data.length !== 2) return 'Value list must have exactly two values.'
      const integer = field.fieldType === 'integer_range'
      if (!data.every((v) => v === null || (integer ? isInt(v) : isNum(v))))
        return integer
          ? 'Value list must contain only integers or null.'
          : 'Value list must contain only floats or null.'
      return null
    }
    case 'boolean':
      return typeof data === 'boolean' ? null : 'Value is not a boolean.'
    case 'choice': {
      const choices = field.choices
      if (field.multiChoice) {
        if (!Array.isArray(data)) return 'Value is not a list.'
        if (!data.every((v) => typeof v === 'string'))
          return 'Value list must contain only strings.'
        if (choices && !data.every((v) => choices.includes(v as string)))
          return 'Value list contains invalid choices.'
        return null
      }
      if (typeof data !== 'string') return 'Value is not a string.'
      if (choices && !choices.includes(data))
        return 'Value is not a valid choice.'
      return null
    }
  }
}

/** Upstream `validate_extra_field_dict`; returns the 400 message or null. */
export function extraDictError(
  fields: readonly SpoolExtraFieldDefinition[],
  input: Record<string, string | null>,
): string | null {
  const lookup = new Map(fields.map((f) => [f.key, f]))
  for (const [key, value] of Object.entries(input)) {
    const field = lookup.get(key)
    if (!field) return `Unknown extra field ${key}.`
    if (value === null) continue
    const error = extraValueError(field, value)
    if (error) return `Invalid extra field for key ${key}: ${error}`
  }
  return null
}

/** Create: drop null values. Update: merge per key, null clears. */
export function mergeExtra(
  current: Record<string, unknown>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(current))
    if (!(key in patch) && typeof value === 'string') out[key] = value
  for (const [key, value] of Object.entries(patch))
    if (value !== null) out[key] = value
  return out
}

/** SQLite `JSON_EXTRACT(value, path)` result, `undefined` for SQL NULL. */
function extract(stored: string, index?: number): Json | undefined {
  const parsed = parseJson(stored)
  if (!parsed) return undefined
  const value =
    index === undefined ? parsed.value : (parsed.value as Json[])?.[index]
  if (value === null || value === undefined) return undefined
  return typeof value === 'boolean' ? (value ? 1 : 0) : value
}

/** Decoded scalar as text for string comparisons, `undefined` otherwise. */
function decodedText(stored: string): string | undefined {
  const value = extract(stored)
  return typeof value === 'string' ? value : undefined
}

const rangeError = (key: string, value: string) =>
  `Invalid range filter value for '${key}': ${value}. Expected '<min>:<max>'.`

type Predicate = (stored: string) => boolean

/** One non-empty filter term to a predicate on the stored value; throws on bad input. */
function termPredicate(
  field: SpoolExtraFieldDefinition,
  term: string,
): Predicate {
  const key = field.key
  const exact = term.startsWith('"') && term.endsWith('"')
  const value = exact ? term.slice(1, -1) : term
  switch (field.fieldType) {
    case 'text':
      return (stored) => {
        const text = decodedText(stored)
        if (text === undefined) return false
        return exact
          ? text === value
          : sqliteLike(text, `%${escapeLike(value)}%`, '/')
      }
    case 'integer':
    case 'float': {
      const integer = field.fieldType === 'integer'
      const parse = integer ? pyInt : pyFloat
      const cast = integer ? sqliteCastInteger : sqliteCastReal
      const kind = integer ? 'integer' : 'float'
      if (value.includes(':')) {
        const [min, max] = [
          value.slice(0, value.indexOf(':')),
          value.slice(value.indexOf(':') + 1),
        ]
        const lo = min ? parse(min) : undefined
        const hi = max ? parse(max) : undefined
        if (
          lo === null ||
          hi === null ||
          (lo === undefined && hi === undefined)
        )
          throw new Error(
            `Invalid ${kind} range filter value for '${key}': ${value}`,
          )
        return (stored) => {
          const n = cast(stored)!
          return (lo === undefined || n >= lo) && (hi === undefined || n <= hi)
        }
      }
      const n = parse(value)
      if (n === null)
        throw new Error(`Invalid ${kind} filter value for '${key}': ${value}`)
      return integer
        ? (stored) => stored === JSON.stringify(n)
        : (stored) => sqliteCastReal(stored) === n
    }
    case 'boolean': {
      const normalized = value.trim().toLowerCase()
      if (normalized !== 'true' && normalized !== 'false')
        throw new Error(`Invalid boolean filter value: ${pyRepr(value)}`)
      return (stored) => stored === normalized
    }
    case 'choice': {
      if (field.multiChoice) {
        const token = `%${escapeLike(JSON.stringify(value))}%`
        return (stored) => sqliteLike(stored, token, '/')
      }
      return (stored) => decodedText(stored) === value
    }
    case 'datetime': {
      if (!value.includes('|')) return (stored) => decodedText(stored) === value
      const start = value.slice(0, value.indexOf('|'))
      const end = value.slice(value.indexOf('|') + 1)
      if (!start && !end)
        throw new Error(
          `Invalid datetime range filter for '${key}': '${value}'. Expected '<start>|<end>' with at least one end given.`,
        )
      return (stored) => {
        const text = decodedText(stored)
        if (text === undefined) return false
        return (!start || text >= start) && (!end || text <= end)
      }
    }
    case 'integer_range':
    case 'float_range': {
      const integer = field.fieldType === 'integer_range'
      if (!value.includes(':')) throw new Error(rangeError(key, value))
      const min = value.slice(0, value.indexOf(':'))
      const max = value.slice(value.indexOf(':') + 1)
      const parse = integer ? pyInt : pyFloat
      const cast = integer ? sqliteCastInteger : sqliteCastReal
      const lo = min ? parse(min) : undefined
      const hi = max ? parse(max) : undefined
      if (lo === null || hi === null)
        throw new Error(
          `Invalid ${integer ? 'integer' : 'float'} range filter value for '${key}': ${value}`,
        )
      if (lo === undefined && hi === undefined)
        throw new Error(rangeError(key, value))
      return (stored) => {
        const first = cast(extract(stored, 0))
        const second = cast(extract(stored, 1))
        return (
          (lo === undefined || (first !== null && first >= lo)) &&
          (hi === undefined || (second !== null && second <= hi))
        )
      }
    }
  }
}

/**
 * Compile `extra.<key>=<value>` filters for registered fields (unknown keys
 * are ignored). Throws `Error` with the upstream 400 message on bad input.
 */
export function compileExtraFilters(
  fields: readonly SpoolExtraFieldDefinition[],
  filters: Map<string, string>,
): ((extra: Record<string, unknown>) => boolean)[] {
  const lookup = new Map(fields.map((f) => [f.key, f]))
  const out: ((extra: Record<string, unknown>) => boolean)[] = []
  for (const [key, raw] of filters) {
    const field = lookup.get(key)
    if (!field) continue
    const alternatives = splitFilterTerms(raw).map((term) => {
      if (term.length === 0)
        return (stored: string | undefined) =>
          stored === undefined ||
          stored === 'null' ||
          stored === '""' ||
          (field.fieldType === 'boolean' && stored === 'false')
      const predicate = termPredicate(field, term)
      return (stored: string | undefined) =>
        stored !== undefined && predicate(stored)
    })
    out.push((extra) => {
      const stored =
        typeof extra[key] === 'string' ? (extra[key] as string) : undefined
      return alternatives.some((match) => match(stored))
    })
  }
  return out
}

/** Sort key for a registered extra field (upstream `extra_field_sort_expr`). */
export function extraSortValue(
  field: SpoolExtraFieldDefinition,
  stored: unknown,
): number | string | null {
  if (typeof stored !== 'string') return null
  switch (field.fieldType) {
    case 'integer':
      return sqliteCastInteger(stored)
    case 'float':
      return sqliteCastReal(stored)
    case 'integer_range':
      return sqliteCastInteger(extract(stored, 0))
    case 'float_range':
      return sqliteCastReal(extract(stored, 0))
    default:
      return stored
  }
}
