/**
 * `GET /api/v1/location`, `PATCH /api/v1/location/{location}` and
 * `PATCH /api/v1/spool/field/{field}` of the pinned Spoolman v0.27.1. A
 * location is only ever a value on this farm's spools.
 */
import { jsonText, tooShort } from './aux-common.ts'
import {
  MUTATING,
  failure,
  message,
  methodNotAllowed,
  respond,
  type LegacyApiModule,
  type LegacyApiRequest,
} from './types.ts'
import { checkBody, unprocessable, type FieldSpec } from './validation.ts'

const LOCATION_BODY: readonly (readonly [string, FieldSpec])[] = [
  ['name', { kind: 'str', required: true }],
]
const RENAME_BODY: readonly (readonly [string, FieldSpec])[] = [
  ['value', { kind: 'str', required: true }],
  ['new_value', { kind: 'str', required: true }],
]

function checkRename(
  request: LegacyApiRequest,
  spec: readonly (readonly [string, FieldSpec])[],
) {
  const checked = checkBody(request.body, spec)
  const issues = [...checked.issues]
  if (!checked.fatal)
    for (const [name] of spec) {
      const value = checked.values[name]
      if (typeof value === 'string' && value.length < 1)
        issues.push(tooShort(['body', name], value))
    }
  return { ok: issues.length === 0, issues, values: checked.values }
}

export const locationModule: LegacyApiModule = {
  name: 'location',
  async handle(repo, request) {
    const location = /^\/api\/v1\/location(?:\/([^/]+))?$/.exec(request.apiPath)
    const field = /^\/api\/v1\/spool\/field\/([^/]+)$/.exec(request.apiPath)
    if (!location && !field) return undefined
    const allowed = location
      ? location[1] === undefined
        ? ['GET']
        : ['PATCH']
      : ['PATCH']
    if (!allowed.includes(request.method)) return methodNotAllowed()
    if (MUTATING.has(request.method) && repo.access === 'read')
      return failure('denied')

    if (location && location[1] === undefined) {
      const all = await repo.locations.list()
      return all.ok ? respond(200, all.value) : all
    }
    if (location) {
      const body = checkRename(request, LOCATION_BODY)
      if (!body.ok) return unprocessable(body.issues)
      const to = body.values['name'] as string
      const renamed = await repo.renameSpoolFieldValue(
        'location',
        location[1]!,
        to,
      )
      return renamed.ok ? jsonText(200, to) : renamed
    }

    const name = field![1]!
    const body = checkRename(request, RENAME_BODY)
    if (!body.ok) return unprocessable(body.issues)
    const from = body.values['value'] as string
    const to = body.values['new_value'] as string
    if (name !== 'location') {
      const key = name.startsWith('extra.') ? name.slice(6) : null
      const defs = await repo.extraFields.list('spool')
      if (!defs.ok) return defs
      const def =
        key === null ? undefined : defs.value.find((f) => f.key === key)
      if (!def)
        return message(
          400,
          `Spool field '${name}' cannot be renamed: use location or extra.<key> of an existing field.`,
        )
      if (!(
        def.fieldType === 'text' ||
        (def.fieldType === 'choice' && !def.multiChoice)
      ))
        return message(
          400,
          `Spool field '${name}' cannot be renamed: only text and single-choice fields can.`,
        )
    }
    const renamed = await repo.renameSpoolFieldValue(name, from, to)
    return renamed.ok
      ? respond(200, { spools_updated: renamed.value })
      : renamed
  },
}
