/**
 * `/api/v1/setting/` and `/api/v1/setting/{key}` of the pinned Spoolman
 * v0.27.1, bound to one farm. Only registered keys exist; an unset key reads
 * as its default. `extra_fields_<entity>` mirror the farm's extra-field
 * registry (managed through `/field`) and are read-only here.
 */
import type {
  SpoolExtraFieldDefinition,
  SpoolLibraryRepository,
} from '../scope.ts'
import { ENTITY_TYPES } from './aux-common.ts'
import { fieldJson } from './field.ts'
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
  registryOf?: (typeof ENTITY_TYPES)[number]
}

export const SETTING_DEFINITIONS: Record<string, SettingDefinition> = {
  currency: { type: 'string', defaultValue: '"EUR"' },
  round_prices: { type: 'boolean', defaultValue: 'false' },
  print_presets: { type: 'array', defaultValue: '[]' },
  base_url: { type: 'string', defaultValue: '""' },
  locations_spoolorders: { type: 'object', defaultValue: '{}' },
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
  const byKey = new Map(stored.value.map((s) => [s.key, s.value]))
  const registry = new Map<string, SpoolExtraFieldDefinition[]>()
  for (const entity of ENTITY_TYPES) {
    const fields = await repo.extraFields.list(entity)
    if (!fields.ok) return fields
    registry.set(entity, fields.value)
  }
  const out: Record<string, SettingView> = {}
  for (const [key, def] of Object.entries(SETTING_DEFINITIONS)) {
    if (def.registryOf) {
      const fields = registry.get(def.registryOf) ?? []
      out[key] = {
        value: JSON.stringify(
          [...fields]
            .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
            .map(fieldJson),
        ),
        is_set: fields.length > 0,
        type: def.type,
      }
      continue
    }
    const has = byKey.has(key)
    out[key] = {
      value: has ? JSON.stringify(byKey.get(key)) : def.defaultValue,
      is_set: has,
      type: def.type,
    }
  }
  return { ok: true, value: out }
}

const notRegistered = (key: string) =>
  message(404, `Setting with key ${key} does not exist.`)

/**
 * POST body: a JSON string holding the JSON text of the value (the Spoolman
 * client double-encodes). Empty, or the text `null`, resets to the default.
 */
function readValue(
  body: LegacyBody,
):
  | { reset: true }
  | { value: unknown }
  | { issue: ReturnType<typeof unprocessable> } {
  if (body.kind === 'none') return { reset: true }
  if (body.kind === 'invalid-json')
    return {
      issue: unprocessable([
        {
          type: 'json_invalid',
          loc: ['body', 0],
          msg: 'JSON decode error',
          input: {},
          ctx: { error: 'Expecting value' },
        },
      ]),
    }
  const input = body.kind === 'raw' ? body.text : body.value
  if (typeof input !== 'string')
    return {
      issue: unprocessable([
        {
          type: 'string_type',
          loc: ['body'],
          msg: 'Input should be a valid string',
          input,
        },
      ]),
    }
  if (input.length === 0 || input === 'null') return { reset: true }
  try {
    return { value: JSON.parse(input) as unknown }
  } catch {
    return { value: undefined }
  }
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

    const def = Object.hasOwn(SETTING_DEFINITIONS, key)
      ? SETTING_DEFINITIONS[key]
      : undefined
    if (!def) return notRegistered(key)
    const read = readValue(request.body)
    if ('issue' in read) return read.issue
    if (def.registryOf)
      return message(
        400,
        `Setting ${key} follows the extra fields; change it through /api/v1/field.`,
      )
    const failedValue = () =>
      message(
        415,
        `Value for setting ${key} must be valid JSON of type ${def.type}.`,
      )
    if ('reset' in read) {
      const reset = await repo.settings.reset(key)
      if (!reset.ok) return reset
    } else {
      if (read.value === undefined || jsonTypeOf(read.value) !== def.type)
        return failedValue()
      const saved = await repo.settings.set(key, read.value)
      if (!saved.ok)
        return saved.reason === 'invalid-input' ? failedValue() : saved
    }
    const views = await settingViews(repo)
    if (!views.ok) return views
    return respond(200, views.value[key])
  },
}
