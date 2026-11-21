/**
 * Request validation shaped like FastAPI + pydantic v2 in the pinned upstream:
 * failures answer 422 `{"detail": [{type, loc, msg, input, ctx?}]}`.
 */
import type { LegacyBody } from './types.ts'
import { respond } from './types.ts'
import { pyLen } from './compat.ts'

export type Loc = (string | number)[]
export interface Issue {
  type: string
  loc: Loc
  msg: string
  input: unknown
  ctx?: Record<string, unknown>
}

export const unprocessable = (issues: Issue[]) =>
  respond(422, { detail: issues })

export const valueError = (loc: Loc, input: unknown, text: string): Issue => ({
  type: 'value_error',
  loc,
  msg: `Value error, ${text}`,
  input,
  ctx: { error: {} },
})

type Checked<T> = { ok: true; value: T } | { ok: false; issue: Issue }
const bad = <T>(issue: Issue): Checked<T> => ({ ok: false, issue })
const good = <T>(value: T): Checked<T> => ({ ok: true, value })

const NUMBER = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/
const SPECIAL = /^\s*[+-]?(inf|infinity|nan)\s*$/i

/** pydantic `float` in lax mode, plus a finite-number guard. */
export function asFloat(loc: Loc, input: unknown): Checked<number> {
  let value: number
  if (typeof input === 'boolean') value = input ? 1 : 0
  else if (typeof input === 'number') value = input
  else if (typeof input === 'string') {
    if (!NUMBER.test(input) && !SPECIAL.test(input))
      return bad({
        type: 'float_parsing',
        loc,
        msg: 'Input should be a valid number, unable to parse string as a number',
        input,
      })
    value = SPECIAL.test(input) ? Number.NaN : Number(input.trim())
  } else
    return bad({
      type: 'float_type',
      loc,
      msg: 'Input should be a valid number',
      input,
    })
  if (!Number.isFinite(value))
    return bad({
      type: 'finite_number',
      loc,
      msg: 'Input should be a finite number',
      input,
    })
  return good(value)
}

/** pydantic `int` in lax mode. */
export function asInt(loc: Loc, input: unknown): Checked<number> {
  let value: number
  if (typeof input === 'boolean') value = input ? 1 : 0
  else if (typeof input === 'number') {
    if (!Number.isFinite(input))
      return bad({
        type: 'finite_number',
        loc,
        msg: 'Input should be a finite number',
        input,
      })
    if (!Number.isInteger(input))
      return bad({
        type: 'int_from_float',
        loc,
        msg: 'Input should be a valid integer, got a number with a fractional part',
        input,
      })
    value = input
  } else if (typeof input === 'string') {
    const match = /^\s*([+-]?\d+)(\.0*)?\s*$/.exec(input)
    if (!match)
      return bad({
        type: 'int_parsing',
        loc,
        msg: 'Input should be a valid integer, unable to parse string as an integer',
        input,
      })
    value = Number(match[1])
  } else
    return bad({
      type: 'int_type',
      loc,
      msg: 'Input should be a valid integer',
      input,
    })
  if (!Number.isSafeInteger(value))
    return bad({
      type: 'int_parsing_size',
      loc,
      msg: 'Unable to parse input string as an integer, exceeded maximum size',
      input,
    })
  return good(value)
}

export function asStr(loc: Loc, input: unknown, max?: number): Checked<string> {
  if (typeof input !== 'string')
    return bad({
      type: 'string_type',
      loc,
      msg: 'Input should be a valid string',
      input,
    })
  if (max !== undefined && pyLen(input) > max)
    return bad({
      type: 'string_too_long',
      loc,
      msg: `String should have at most ${max} characters`,
      input,
      ctx: { max_length: max },
    })
  return good(input)
}

export type FieldSpec =
  | { kind: 'str'; max?: number; required?: boolean }
  | { kind: 'float'; ge?: number; gt?: number; required?: boolean }
  | { kind: 'int'; ge?: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'extra' }

function checkField(
  loc: Loc,
  spec: FieldSpec,
  input: unknown,
): Checked<unknown> {
  if (input === null && !('required' in spec && spec.required))
    return good(null)
  switch (spec.kind) {
    case 'str':
      return asStr(loc, input, spec.max)
    case 'float': {
      const n = asFloat(loc, input)
      if (!n.ok) return n
      if (spec.gt !== undefined && !(n.value > spec.gt))
        return bad({
          type: 'greater_than',
          loc,
          msg: `Input should be greater than ${spec.gt}`,
          input,
          ctx: { gt: spec.gt },
        })
      if (spec.ge !== undefined && !(n.value >= spec.ge))
        return bad({
          type: 'greater_than_equal',
          loc,
          msg: `Input should be greater than or equal to ${spec.ge}`,
          input,
          ctx: { ge: spec.ge },
        })
      return n
    }
    case 'int': {
      const n = asInt(loc, input)
      if (!n.ok) return n
      if (spec.ge !== undefined && !(n.value >= spec.ge))
        return bad({
          type: 'greater_than_equal',
          loc,
          msg: `Input should be greater than or equal to ${spec.ge}`,
          input,
          ctx: { ge: spec.ge },
        })
      return n
    }
    case 'enum': {
      if (typeof input === 'string' && spec.values.includes(input))
        return good(input)
      const expected =
        spec.values.length === 1
          ? `'${spec.values[0]}'`
          : `${spec.values
              .slice(0, -1)
              .map((v) => `'${v}'`)
              .join(', ')} or '${spec.values.at(-1)}'`
      return bad({
        type: 'enum',
        loc,
        msg: `Input should be ${expected}`,
        input,
        ctx: { expected },
      })
    }
    case 'extra':
      return good(input)
  }
}

/**
 * `fatal` is set when the body is not a model at all (missing, not JSON, not
 * an object); otherwise `values`/`set` hold every field that passed its type
 * check, so field validators can still run next to failed siblings.
 */
export interface BodyCheck {
  ok: boolean
  fatal: boolean
  issues: Issue[]
  values: Record<string, unknown>
  set: Set<string>
}
const fatal = (issue: Issue): BodyCheck => ({
  ok: false,
  fatal: true,
  issues: [issue],
  values: {},
  set: new Set(),
})

/**
 * Validate a JSON body against field specs in upstream declaration order.
 * `set` holds the keys the client sent (pydantic `exclude_unset`). `extra`
 * values must be a dict of string-or-null (reported per key).
 */
export function checkBody(
  body: LegacyBody,
  fields: readonly (readonly [string, FieldSpec])[],
): BodyCheck {
  if (body.kind === 'invalid-json')
    return fatal({
      type: 'json_invalid',
      loc: ['body', 0],
      msg: 'JSON decode error',
      input: {},
      ctx: { error: 'Expecting value' },
    })
  if (body.kind === 'none')
    return fatal({
      type: 'missing',
      loc: ['body'],
      msg: 'Field required',
      input: null,
    })
  const input = body.kind === 'raw' ? body.text : body.value
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return fatal({
      type: 'model_attributes_type',
      loc: ['body'],
      msg: 'Input should be a valid dictionary or object to extract fields from',
      input,
    })
  const record = input as Record<string, unknown>
  const issues: Issue[] = []
  const values: Record<string, unknown> = {}
  const set = new Set<string>()
  for (const [name, spec] of fields) {
    const loc: Loc = ['body', name]
    if (!Object.hasOwn(record, name)) {
      if ('required' in spec && spec.required)
        issues.push({
          type: 'missing',
          loc,
          msg: 'Field required',
          input: record,
        })
      continue
    }
    set.add(name)
    const raw = record[name]
    if (spec.kind === 'extra') {
      const extra = checkExtraMap(loc, raw)
      if (Array.isArray(extra)) issues.push(...extra)
      else values[name] = extra
      continue
    }
    const checked = checkField(loc, spec, raw)
    if (checked.ok) values[name] = checked.value
    else issues.push(checked.issue)
  }
  return { ok: issues.length === 0, fatal: false, issues, values, set }
}

function checkExtraMap(
  loc: Loc,
  raw: unknown,
): Record<string, string | null> | null | Issue[] {
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw))
    return [
      {
        type: 'dict_type',
        loc,
        msg: 'Input should be a valid dictionary',
        input: raw,
      },
    ]
  const issues: Issue[] = []
  const out: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value === 'string') out[key] = value
    else
      issues.push({
        type: 'string_type',
        loc: [...loc, key],
        msg: 'Input should be a valid string',
        input: value,
      })
  }
  return issues.length ? issues : out
}

/** Order body issues by declared field position (pydantic validates in order). */
export function byFieldOrder(
  issues: Issue[],
  fields: readonly (readonly [string, FieldSpec])[],
): Issue[] {
  const position = (issue: Issue) => {
    const index = fields.findIndex(([name]) => name === issue.loc[1])
    return index === -1 ? fields.length : index
  }
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => position(a.issue) - position(b.issue) || a.i - b.i)
    .map(({ issue }) => issue)
}

/** Path parameter `int` (FastAPI loc `["path", name]`). */
export function pathInt(name: string, raw: string): Checked<number> {
  return asInt(['path', name], raw)
}
