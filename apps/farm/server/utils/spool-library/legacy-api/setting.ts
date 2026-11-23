/**
 * `/api/v1/setting/` and `/api/v1/setting/{key}` of the pinned Spoolman
 * v0.27.1, bound to one farm. Only registered keys exist; an unset key reads
 * as its default. `extra_fields_<entity>` are views of the farm's extra-field
 * registry (the same data `/field` manages): a write replaces the registry.
 */
import type {
  SpoolEntityType,
  SpoolExtraFieldDefinition,
  SpoolExtraFieldType,
  SpoolLibraryRepository,
} from '../scope.ts'
import { ENTITY_TYPES } from './aux-common.ts'
import { pyLen, pyRepr } from './compat.ts'
import { extraValueError } from './extra-fields.ts'
import { MAX_EXTRA_FIELDS } from './field.ts'
import { pyJsonDecodeError, pyJsonDumps } from './py-json.ts'
import {
  MUTATING,
  failure,
  message,
  methodNotAllowed,
  respond,
  type LegacyApiModule,
  type LegacyBody,
} from './types.ts'
import { unprocessable } from './validation.ts'

export type SettingType = 'boolean' | 'number' | 'string' | 'array' | 'object'

interface SettingDefinition {
  type: SettingType
  /** JSON text of the default value. */
  defaultValue: string
  /** Backed by the extra-field registry instead of the settings table. */
  registryOf?: SpoolEntityType
}

/** Upstream `SETTINGS`, in registration order. */
export const SETTING_DEFINITIONS: Record<string, SettingDefinition> = {
  currency: { type: 'string', defaultValue: '"EUR"' },
  round_prices: { type: 'boolean', defaultValue: 'false' },
  print_presets: { type: 'array', defaultValue: '[]' },
  label_designs: { type: 'array', defaultValue: '[]' },
  extra_fields_vendor: {
    type: 'array',
    defaultValue: '[]',
    registryOf: 'vendor',
  },
  extra_fields_filament: {
    type: 'array',
    defaultValue: '[]',
    registryOf: 'filament',
  },
  extra_fields_spool: {
    type: 'array',
    defaultValue: '[]',
    registryOf: 'spool',
  },
  base_url: { type: 'string', defaultValue: '""' },
  locations: { type: 'array', defaultValue: '[]' },
  locations_spoolorders: { type: 'object', defaultValue: '{}' },
  dashboard_groups: { type: 'object', defaultValue: '{}' },
  dashboard_spoolorders: { type: 'object', defaultValue: '{}' },
}

export interface SettingView {
  value: string
  is_set: boolean
  type: SettingType
}

const jsonTypeOf = (value: unknown): SettingType | null =>
  typeof value === 'boolean'
    ? 'boolean'
    : typeof value === 'number'
      ? 'number'
      : typeof value === 'string'
        ? 'string'
        : Array.isArray(value)
          ? 'array'
          : typeof value === 'object' && value !== null
            ? 'object'
            : null

/**
 * The registry as upstream stores it in its `extra_fields_<entity>` setting:
 * `json.dumps` of the models, every member present (`null` when unset).
 */
export function registryText(fields: readonly SpoolExtraFieldDefinition[]) {
  return pyJsonDumps(
    fields.map((field) => ({
      name: field.name,
      order: field.order,
      unit: field.unit,
      field_type: field.fieldType,
      default_value: field.defaultValue,
      choices: field.choices,
      multi_choice: field.fieldType === 'choice' ? field.multiChoice : null,
      key: field.key,
      entity_type: field.entityType,
    })),
  )
}

/** Every registered setting as the API shows it, set or not. */
export async function settingViews(repo: SpoolLibraryRepository): Promise<
  | { ok: true; value: Record<string, SettingView> }
  | {
      ok: false
      reason:
        | 'storage-unavailable'
        | 'invalid-input'
        | 'unauthorized'
        | 'forbidden'
        | 'denied'
        | 'not-found'
        | 'conflict'
        | 'limit'
    }
> {
  const stored = await repo.settings.list()
  if (!stored.ok) return stored
  const registry = new Map<string, SpoolExtraFieldDefinition[]>()
  for (const entity of ENTITY_TYPES) {
    const fields = await repo.extraFields.list(entity)
    if (!fields.ok) return fields
    registry.set(entity, fields.value)
  }
  const view = (
    key: string,
    def: SettingDefinition,
    value: unknown,
    isSet: boolean,
  ): SettingView => ({
    value: !isSet
      ? def.defaultValue
      : def.registryOf
        ? // A direct write to the setting is read back as sent until a field
          // endpoint rewrites the registry.
          typeof value === 'string'
          ? value
          : registryText(registry.get(def.registryOf) ?? [])
        : JSON.stringify(value),
    is_set: isSet,
    type: def.type,
  })
  const out: Record<string, SettingView> = {}
  // Upstream lists the settings that were set first, in the order they were
  // first written, then the unset ones in registration order.
  for (const row of stored.value) {
    const def = Object.hasOwn(SETTING_DEFINITIONS, row.key)
      ? SETTING_DEFINITIONS[row.key]
      : undefined
    if (def) out[row.key] = view(row.key, def, row.value, true)
  }
  for (const [key, def] of Object.entries(SETTING_DEFINITIONS))
    if (!(key in out)) out[key] = view(key, def, undefined, false)
  return { ok: true, value: out }
}

const notRegistered = (key: string) =>
  message(404, `Setting ${key} does not exist.`)

const MAX_LENGTH = 2 ** 16 - 1
const TYPE_NAME: Record<SettingType, string> = {
  boolean: 'a boolean',
  number: 'a number',
  string: 'a string',
  array: 'an array',
  object: 'an object',
}

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

type Parsed = { definition: SpoolExtraFieldDefinition } | { error: string }

/** One entry of an `extra_fields_*` array as upstream's `ExtraField` model. */
function parseRegistryEntry(
  item: unknown,
  index: number,
  entity: SpoolEntityType,
): Parsed {
  const bad = { error: `Extra field at index ${index} is not valid.` }
  if (typeof item !== 'object' || item === null || Array.isArray(item))
    return bad
  const o = item as Record<string, unknown>
  const str = (v: unknown, min: number, max: number) =>
    typeof v === 'string' && pyLen(v) >= min && pyLen(v) <= max
  const optionalStr = (v: unknown, min: number, max: number) =>
    v === undefined || v === null || str(v, min, max)
  if (
    !str(o['name'], 1, 128) ||
    !(o['order'] === undefined || Number.isInteger(o['order'])) ||
    !optionalStr(o['unit'], 1, 16) ||
    !FIELD_TYPES.includes(o['field_type'] as SpoolExtraFieldType) ||
    !optionalStr(o['default_value'], 0, Infinity) ||
    !(
      o['choices'] === undefined ||
      o['choices'] === null ||
      (Array.isArray(o['choices']) &&
        o['choices'].length >= 1 &&
        o['choices'].every((c) => typeof c === 'string'))
    ) ||
    !(
      o['multi_choice'] === undefined ||
      o['multi_choice'] === null ||
      typeof o['multi_choice'] === 'boolean'
    ) ||
    !str(o['key'], 1, 64) ||
    !/^[a-z0-9_]+$/.test(o['key'] as string) ||
    !ENTITY_TYPES.includes(o['entity_type'] as SpoolEntityType)
  )
    return bad
  if (o['entity_type'] !== entity)
    return {
      error: `Extra field at index ${index} has entity type ${pyRepr(String(o['entity_type']))}, expected ${pyRepr(entity)}.`,
    }
  const fieldType = o['field_type'] as SpoolExtraFieldType
  const choices = (o['choices'] as string[] | null | undefined) ?? null
  const multi = o['multi_choice'] as boolean | null | undefined
  const definition: SpoolExtraFieldDefinition = {
    entityType: entity,
    key: o['key'] as string,
    name: o['name'] as string,
    order: (o['order'] as number | undefined) ?? 0,
    unit: (o['unit'] as string | null | undefined) ?? null,
    fieldType,
    defaultValue: (o['default_value'] as string | null | undefined) ?? null,
    choices,
    multiChoice: multi ?? false,
  }
  let problem: string | null = null
  if (fieldType === 'choice') {
    if (choices === null) problem = 'Choices must be set for field type choice.'
    else if (multi === null || multi === undefined)
      problem = 'Multi choice must be set for field type choice.'
  } else if (choices !== null)
    problem = 'Choices must not be set for field type other than choice.'
  else if (multi !== null && multi !== undefined)
    problem = 'Multi choice must not be set for field type other than choice.'
  if (problem === null && definition.defaultValue !== null) {
    const error = extraValueError(definition, definition.defaultValue)
    if (error) problem = `Default value is not valid: ${error}`
  }
  return problem
    ? { error: `Extra field at index ${index} is not valid: ${problem}` }
    : { definition }
}

/** Upstream `validate_extra_field_setting` for the array already parsed. */
function parseRegistry(
  key: string,
  entity: SpoolEntityType,
  items: unknown[],
): { definitions: SpoolExtraFieldDefinition[] } | { error: string } {
  if (items.length > MAX_EXTRA_FIELDS)
    return {
      error: `Setting ${key} has ${items.length} extra fields, the maximum is ${MAX_EXTRA_FIELDS}.`,
    }
  const definitions: SpoolExtraFieldDefinition[] = []
  for (const [index, item] of items.entries()) {
    const parsed = parseRegistryEntry(item, index, entity)
    if ('error' in parsed) return parsed
    definitions.push(parsed.definition)
  }
  if (new Set(definitions.map((d) => d.key)).size !== definitions.length)
    return { error: `Setting ${key} contains duplicate extra field keys.` }
  return { definitions }
}

/**
 * Replace the farm's registry for `entity` with `definitions`, in order.
 * Values already stored on records are left alone, as upstream does when the
 * setting is written.
 */
async function replaceRegistry(
  repo: SpoolLibraryRepository,
  entity: SpoolEntityType,
  definitions: SpoolExtraFieldDefinition[],
  text: string,
) {
  const existing = await repo.extraFields.list(entity)
  if (!existing.ok) return existing
  const keep = new Set(definitions.map((d) => d.key))
  for (const field of existing.value)
    if (!keep.has(field.key)) {
      const removed = await repo.extraFields.delete(entity, field.key, true)
      if (!removed.ok) return removed
    }
  for (const definition of definitions) {
    const saved = await repo.extraFields.upsert(definition)
    if (!saved.ok) return saved
  }
  return repo.settings.set(`extra_fields_${entity}`, text)
}

type Read = { early: ReturnType<typeof respond> } | { text: string }

/**
 * Media type of the request; a caller that does not describe it (no
 * `bodyDetails`) is taken to have sent JSON unless the body is not JSON.
 */
const mediaType = (body: LegacyBody) =>
  body.contentType ?? (body.kind === 'raw' ? 'text/plain' : 'application/json')

/**
 * POST body: one JSON string holding the JSON text of the value, as FastAPI
 * reads `body: str` behind the JSON-content-type dependency.
 */
function readText(body: LegacyBody): Read {
  if (body.kind === 'invalid-json')
    return {
      early: unprocessable([
        {
          type: 'json_invalid',
          loc: ['body', 0],
          msg: 'JSON decode error',
          input: {},
          ctx: { error: body.error ?? 'Expecting value' },
        },
      ]),
    }
  const media = mediaType(body)
  if (media !== 'application/json' && !media.endsWith('+json'))
    return {
      early: respond(415, {
        detail: `Unsupported content type ${pyRepr(media)}. The body of this endpoint must be sent as application/json.`,
      }),
    }
  if (body.kind === 'none' && !body.jsonNull)
    return {
      early: unprocessable([
        { type: 'missing', loc: ['body'], msg: 'Field required', input: null },
      ]),
    }
  const input =
    body.kind === 'raw' ? body.text : body.kind === 'json' ? body.value : null
  if (typeof input !== 'string')
    return {
      early: unprocessable([
        {
          type: 'string_type',
          loc: ['body'],
          msg: 'Input should be a valid string',
          input,
        },
      ]),
    }
  return { text: input }
}

export const settingModule: LegacyApiModule = {
  name: 'setting',
  async handle(repo, request) {
    const match = /^\/api\/v1\/setting\/(?:([^/]+))?$/.exec(request.apiPath)
    if (!match) return undefined
    const key = match[1]
    const allowed = key === undefined ? ['GET'] : ['GET', 'POST']
    if (!allowed.includes(request.method)) return methodNotAllowed()
    if (MUTATING.has(request.method) && repo.access === 'read')
      return failure('denied')

    if (key === undefined || request.method === 'GET') {
      const views = await settingViews(repo)
      if (!views.ok) return views
      if (key === undefined) return respond(200, views.value)
      const view = views.value[key]
      return view && Object.hasOwn(SETTING_DEFINITIONS, key)
        ? respond(200, view)
        : notRegistered(key)
    }

    const read = readText(request.body)
    if ('early' in read) return read.early
    const def = Object.hasOwn(SETTING_DEFINITIONS, key)
      ? SETTING_DEFINITIONS[key]
      : undefined
    if (!def) return notRegistered(key)
    const text = read.text
    if (text !== '' && text !== 'null') {
      const decodeError = pyJsonDecodeError(text)
      if (decodeError) return message(400, decodeError.text)
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        value = undefined
      }
      if (jsonTypeOf(value) !== def.type)
        return message(400, `Setting ${key} must be ${TYPE_NAME[def.type]}.`)
      let definitions: SpoolExtraFieldDefinition[] | undefined
      if (def.registryOf) {
        const parsed = parseRegistry(key, def.registryOf, value as unknown[])
        if ('error' in parsed) return message(400, parsed.error)
        definitions = parsed.definitions
      }
      if (pyLen(text) > MAX_LENGTH)
        return message(
          400,
          `Setting value is too big, max size is ${MAX_LENGTH} characters.`,
        )
      const saved =
        def.registryOf && definitions
          ? await replaceRegistry(repo, def.registryOf, definitions, text)
          : await repo.settings.set(key, value)
      if (!saved.ok) return saved
    } else {
      const views = await settingViews(repo)
      if (!views.ok) return views
      if (!views.value[key]?.is_set)
        return message(404, `Setting with key ${key} has not been set.`)
      if (def.registryOf) {
        const existing = await repo.extraFields.list(def.registryOf)
        if (!existing.ok) return existing
        for (const field of existing.value) {
          const removed = await repo.extraFields.delete(
            def.registryOf,
            field.key,
            true,
          )
          if (!removed.ok) return removed
        }
      }
      const reset = await repo.settings.reset(key)
      if (!reset.ok) return reset
    }
    const views = await settingViews(repo)
    if (!views.ok) return views
    return respond(200, views.value[key])
  },
}
