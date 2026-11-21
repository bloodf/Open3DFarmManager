/**
 * `/api/v1/field/{entity_type}[/{key}[/values]]` of the pinned Spoolman
 * v0.27.1: the farm's extra-field registry. Every write answers with the
 * entity's full definition list, as upstream does.
 */
import type {
  SpoolEntityType,
  SpoolExtraFieldDefinition,
  SpoolExtraFieldType,
  SpoolLibraryRepository,
} from '../scope.ts'
import { entityParam, keyParam, tooShort } from './aux-common.ts'
import { extraValueError } from './extra-fields.ts'
import { loadAll } from './records.ts'
import {
  MUTATING,
  failure,
  message,
  methodNotAllowed,
  respond,
  type LegacyApiModule,
  type LegacyApiRequest,
  type LegacyModuleResult,
} from './types.ts'
import {
  checkBody,
  unprocessable,
  type FieldSpec,
  type Issue,
} from './validation.ts'

const FIELD_TYPES: readonly SpoolExtraFieldType[] = [
  'text',
  'integer',
  'integer_range',
  'float',
  'float_range',
  'datetime',
  'boolean',
  'choice',
]

/** Wire shape of `ExtraField` (nulls are present, as upstream sends them). */
export function fieldJson(field: SpoolExtraFieldDefinition) {
  return {
    key: field.key,
    entity_type: field.entityType,
    name: field.name,
    order: field.order,
    unit: field.unit,
    field_type: field.fieldType,
    default_value: field.defaultValue,
    choices: field.choices,
    multi_choice: field.multiChoice,
  }
}

const sorted = (fields: SpoolExtraFieldDefinition[]) =>
  [...fields].sort(
    (a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )

const BODY: readonly (readonly [string, FieldSpec])[] = [
  ['name', { kind: 'str', max: 128, required: true }],
  ['order', { kind: 'int' }],
  ['unit', { kind: 'str', max: 16 }],
  ['field_type', { kind: 'enum', values: FIELD_TYPES }],
  ['default_value', { kind: 'str' }],
  ['multi_choice', { kind: 'bool' }],
]

/** Body validation: pydantic issues first, then the registry's own 400 rules. */
function parseBody(
  request: LegacyApiRequest,
  extraIssues: Issue[],
):
  | { issues: Issue[] }
  | { definition: Omit<SpoolExtraFieldDefinition, 'entityType' | 'key'> } {
  const checked = checkBody(request.body, BODY)
  const issues = [...extraIssues, ...checked.issues]
  if (checked.fatal) return { issues }
  const v = checked.values
  if (!checked.set.has('field_type'))
    issues.push({
      type: 'missing',
      loc: ['body', 'field_type'],
      msg: 'Field required',
      input: request.body.kind === 'json' ? request.body.value : null,
    })
  else if (v['field_type'] === null) {
    const expected = FIELD_TYPES.slice(0, -1)
      .map((t) => `'${t}'`)
      .join(', ')
    issues.push({
      type: 'enum',
      loc: ['body', 'field_type'],
      msg: `Input should be ${expected} or 'choice'`,
      input: null,
      ctx: { expected: `${expected} or 'choice'` },
    })
  }
  if (typeof v['name'] === 'string' && [...v['name']].length < 1)
    issues.push(tooShort(['body', 'name'], v['name']))
  if (typeof v['unit'] === 'string' && [...v['unit']].length < 1)
    issues.push(tooShort(['body', 'unit'], v['unit']))
  // `choices`: list[str] (min 1 item), validated by hand.
  let choices: string[] | null = null
  const raw =
    request.body.kind === 'json' &&
    typeof request.body.value === 'object' &&
    request.body.value !== null
      ? (request.body.value as Record<string, unknown>)['choices']
      : undefined
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw))
      issues.push({
        type: 'list_type',
        loc: ['body', 'choices'],
        msg: 'Input should be a valid list',
        input: raw,
      })
    else {
      raw.forEach((item, i) => {
        if (typeof item !== 'string')
          issues.push({
            type: 'string_type',
            loc: ['body', 'choices', i],
            msg: 'Input should be a valid string',
            input: item,
          })
      })
      if (raw.length < 1)
        issues.push({
          type: 'too_short',
          loc: ['body', 'choices'],
          msg: 'List should have at least 1 item after validation, not 0',
          input: raw,
          ctx: { field_type: 'List', min_length: 1, actual_length: 0 },
        })
      else if (raw.every((item) => typeof item === 'string'))
        choices = raw as string[]
    }
  }
  if (issues.length) return { issues }
  return {
    definition: {
      name: v['name'] as string,
      order: (v['order'] as number | null | undefined) ?? 0,
      unit: (v['unit'] as string | null | undefined) ?? null,
      fieldType: v['field_type'] as SpoolExtraFieldType,
      defaultValue: (v['default_value'] as string | null | undefined) ?? null,
      choices,
      multiChoice: (v['multi_choice'] as boolean | null | undefined) ?? false,
    },
  }
}

/** Registry rules the pinned upstream enforces with a 400 `Message`. */
function definitionError(
  definition: SpoolExtraFieldDefinition,
  existing: SpoolExtraFieldDefinition | undefined,
): string | null {
  if (existing && existing.fieldType !== definition.fieldType)
    return 'Field type cannot be changed once the field exists.'
  if (definition.fieldType === 'choice') {
    if (!definition.choices || definition.choices.length === 0)
      return 'Choices must be set for a field of type choice.'
  } else {
    if (definition.choices !== null)
      return 'Choices can only be set for a field of type choice.'
    if (definition.multiChoice)
      return 'Multi choice can only be set for a field of type choice.'
  }
  if (definition.defaultValue !== null) {
    const error = extraValueError(definition, definition.defaultValue)
    if (error) return `Default value is not valid: ${error}`
  }
  return null
}

async function list(
  repo: SpoolLibraryRepository,
  entity: SpoolEntityType,
): Promise<LegacyModuleResult> {
  const fields = await repo.extraFields.list(entity)
  return fields.ok ? respond(200, sorted(fields.value).map(fieldJson)) : fields
}

const missingField = (key: string) =>
  message(404, `Extra field with key ${key} does not exist.`)

async function values(
  repo: SpoolLibraryRepository,
  entity: SpoolEntityType,
  key: string,
): Promise<LegacyModuleResult> {
  const fields = await repo.extraFields.list(entity)
  if (!fields.ok) return fields
  if (!fields.value.some((f) => f.key === key)) return missingField(key)
  const rows =
    entity === 'vendor'
      ? await loadAll((page) => repo.vendors.list(page))
      : entity === 'filament'
        ? await loadAll((page) => repo.filaments.list(page))
        : await loadAll((page) => repo.spools.list(page))
  if (!rows.ok) return rows
  const seen = new Set<string>()
  for (const row of rows.value) {
    const stored = row.extra[key]
    if (typeof stored !== 'string') continue
    let decoded: unknown
    try {
      decoded = JSON.parse(stored)
    } catch {
      continue
    }
    for (const item of Array.isArray(decoded) ? decoded : [decoded])
      if (item !== null && item !== undefined)
        seen.add(typeof item === 'string' ? item : JSON.stringify(item))
  }
  return respond(
    200,
    [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  )
}

export const fieldModule: LegacyApiModule = {
  name: 'field',
  async handle(repo, request) {
    const match = /^\/api\/v1\/field\/([^/]+)(?:\/([^/]+)(\/values)?)?$/.exec(
      request.apiPath,
    )
    if (!match) return undefined
    const [, rawEntity, rawKey, valuesSuffix] = match as unknown as [
      string,
      string,
      string | undefined,
      string | undefined,
    ]
    const allowed =
      rawKey === undefined
        ? ['GET']
        : valuesSuffix
          ? ['GET']
          : ['POST', 'DELETE']
    if (!allowed.includes(request.method)) return methodNotAllowed()
    if (MUTATING.has(request.method) && repo.access === 'read')
      return failure('denied')

    const issues: Issue[] = []
    const entity = entityParam(rawEntity)
    if (!entity.ok) issues.push(entity.issue)
    const key = rawKey === undefined ? undefined : keyParam(rawKey)
    if (key && !key.ok) issues.push(key.issue)
    if (request.method === 'POST') {
      const parsed = parseBody(request, issues)
      if ('issues' in parsed) return unprocessable(parsed.issues)
      if (!entity.ok || !key?.ok) return unprocessable(issues)
      const existing = await repo.extraFields.list(entity.value)
      if (!existing.ok) return existing
      const definition: SpoolExtraFieldDefinition = {
        ...parsed.definition,
        entityType: entity.value,
        key: key.value,
      }
      const error = definitionError(
        definition,
        existing.value.find((f) => f.key === definition.key),
      )
      if (error) return message(400, error)
      const saved = await repo.extraFields.upsert(definition)
      if (!saved.ok)
        return saved.reason === 'limit'
          ? message(400, 'Too many extra fields for this entity type.')
          : saved
      return list(repo, entity.value)
    }
    if (issues.length) return unprocessable(issues)
    if (!entity.ok) return unprocessable(issues)
    if (request.method === 'GET' && key === undefined)
      return list(repo, entity.value)
    if (!key?.ok) return unprocessable(issues)
    if (request.method === 'GET') return values(repo, entity.value, key.value)
    const removed = await repo.extraFields.delete(entity.value, key.value)
    if (!removed.ok)
      return removed.reason === 'not-found' ? missingField(key.value) : removed
    return list(repo, entity.value)
  },
}
