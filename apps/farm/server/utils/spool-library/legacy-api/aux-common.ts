/** Shared helpers for the auxiliary Spoolman endpoints (#545). */
import type { SpoolEntityType } from '../scope.ts'
import { respond } from './types.ts'
import type { Issue, Loc } from './validation.ts'

export const ENTITY_TYPES: readonly SpoolEntityType[] = [
  'vendor',
  'filament',
  'spool',
]
export const KEY_PATTERN = /^[a-z0-9_]+$/

type Checked<T> = { ok: true; value: T } | { ok: false; issue: Issue }

/** Path `EntityType` enum: FastAPI loc `["path", "entity_type"]`. */
export function entityParam(raw: string): Checked<SpoolEntityType> {
  const found = ENTITY_TYPES.find((entity) => entity === raw)
  if (found) return { ok: true, value: found }
  const expected = "'vendor', 'filament' or 'spool'"
  return {
    ok: false,
    issue: {
      type: 'enum',
      loc: ['path', 'entity_type'],
      msg: `Input should be ${expected}`,
      input: raw,
      ctx: { expected },
    },
  }
}

/** Path `key` constrained to `^[a-z0-9_]+$`, 1..64 characters. */
export function keyParam(
  raw: string,
  loc: Loc = ['path', 'key'],
): Checked<string> {
  const length = [...raw].length
  if (length < 1)
    return {
      ok: false,
      issue: {
        type: 'string_too_short',
        loc,
        msg: 'String should have at least 1 character',
        input: raw,
        ctx: { min_length: 1 },
      },
    }
  if (length > 64)
    return {
      ok: false,
      issue: {
        type: 'string_too_long',
        loc,
        msg: 'String should have at most 64 characters',
        input: raw,
        ctx: { max_length: 64 },
      },
    }
  if (!KEY_PATTERN.test(raw))
    return {
      ok: false,
      issue: {
        type: 'string_pattern_mismatch',
        loc,
        msg: "String should match pattern '^[a-z0-9_]+$'",
        input: raw,
        ctx: { pattern: '^[a-z0-9_]+$' },
      },
    }
  return { ok: true, value: raw }
}

/** `string_too_short` for a body or query string that must not be empty. */
export const tooShort = (loc: Loc, input: unknown, min = 1): Issue => ({
  type: 'string_too_short',
  loc,
  msg: `String should have at least ${min} character${min === 1 ? '' : 's'}`,
  input,
  ctx: { min_length: min },
})

/** A JSON-encoded string response (`RootModel[str]`). */
export const jsonText = (status: number, text: string) =>
  respond(status, JSON.stringify(text), { 'content-type': 'application/json' })

/**
 * Distinct strings in order of first appearance: upstream selects DISTINCT
 * without an order, so the first record to hold a value lists it.
 */
export function distinct(
  values: Iterable<string | null | undefined>,
): string[] {
  const seen = new Set<string>()
  for (const value of values)
    if (value !== null && value !== undefined) seen.add(value)
  return [...seen]
}
