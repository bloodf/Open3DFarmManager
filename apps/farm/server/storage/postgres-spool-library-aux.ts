/**
 * Farm-scoped storage behind the Spoolman auxiliary endpoints (#545): the
 * extra-field registry writes, settings, locations and the spool field-value
 * rename. Every statement carries the resolved farm id; there is no farm
 * argument. Settings and field-definition writes need the `farm_spool_features`
 * role from migration 0089 on top of `farm_spool_library`; location and
 * field-value renames use only the spool library's own column grants.
 */
import type { Sql } from 'postgres'
import type {
  Result,
  SpoolEntityType,
  SpoolExtraFieldDefinition,
  SpoolLibraryRepository,
  SpoolSetting,
} from '../utils/spool-library/scope.ts'

export interface AuxContext {
  farmId: string
  now: number
  /** One savepoint per operation, as `ScopedRepository.guarded`. */
  guarded<T>(
    mutates: boolean,
    work: (sp: Sql) => Promise<Result<T>>,
  ): Promise<Result<T>>
}

export type AuxRepository = Pick<
  SpoolLibraryRepository,
  'settings' | 'locations' | 'renameSpoolFieldValue'
> & {
  extraFieldWrites: Pick<
    SpoolLibraryRepository['extraFields'],
    'upsert' | 'delete'
  >
}

/** Upstream bounds: 128 definitions per entity would be generous; stay under the list cap. */
const MAX_FIELDS_PER_ENTITY = 256
const KEY = /^[a-z0-9_]{1,64}$/
const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const invalid = { ok: false, reason: 'invalid-input' } as const
const missing = { ok: false, reason: 'not-found' } as const

/** Fixed table per entity: never interpolate caller text into SQL. */
const ENTITY_TABLE: Record<SpoolEntityType, string> = {
  vendor: 'farm.spool_vendors',
  filament: 'farm.spool_filaments',
  spool: 'farm.spools',
}

export function createAuxRepository(ctx: AuxContext): AuxRepository {
  const farm = ctx.farmId
  return {
    extraFieldWrites: {
      upsert: (definition: SpoolExtraFieldDefinition) =>
        ctx.guarded(true, async (sp) => {
          if (
            !KEY.test(definition.key) ||
            !(definition.entityType in ENTITY_TABLE)
          )
            return invalid
          const existing = await sp<{ n: number }[]>`
            SELECT count(*)::int AS n FROM farm.spool_library_fields
            WHERE farm_id=${farm}::uuid AND entity_type=${definition.entityType}
              AND key<>${definition.key}`
          if ((existing[0]?.n ?? 0) >= MAX_FIELDS_PER_ENTITY)
            return { ok: false, reason: 'limit' } as const
          await sp`
            INSERT INTO farm.spool_library_fields
              (farm_id, entity_type, key, name, field_type, sort_order, unit, default_value, choices, multi_choice, updated_at)
            VALUES (${farm}::uuid, ${definition.entityType}, ${definition.key}, ${definition.name}, ${definition.fieldType},
              ${definition.order}, ${definition.unit}, ${definition.defaultValue},
              ${definition.choices === null ? null : sp.json(definition.choices as never)},
              ${definition.multiChoice}, ${ctx.now})
            ON CONFLICT (farm_id, entity_type, key) DO UPDATE SET
              name=EXCLUDED.name, field_type=EXCLUDED.field_type, sort_order=EXCLUDED.sort_order,
              unit=EXCLUDED.unit, default_value=EXCLUDED.default_value, choices=EXCLUDED.choices,
              multi_choice=EXCLUDED.multi_choice, updated_at=EXCLUDED.updated_at,
              source_key='local',
              source_sha256='0000000000000000000000000000000000000000000000000000000000000000'`
          return ok(true as const)
        }),
      delete: (entity: SpoolEntityType, key: string) =>
        ctx.guarded(true, async (sp) => {
          if (!KEY.test(key) || !(entity in ENTITY_TABLE)) return invalid
          const rows = await sp`
            DELETE FROM farm.spool_library_fields
            WHERE farm_id=${farm}::uuid AND entity_type=${entity} AND key=${key}
            RETURNING key`
          if (!rows[0]) return missing
          // Upstream also drops the value from every record of the entity.
          await sp`UPDATE ${sp.unsafe(ENTITY_TABLE[entity])} SET extra = extra - ${key}::text
            WHERE farm_id=${farm}::uuid AND extra ? ${key}::text`
          return ok(true as const)
        }),
    },

    settings: {
      list: () =>
        ctx.guarded(false, async (sp) =>
          ok(
            await sp<
              SpoolSetting[]
            >`SELECT key, value FROM farm.spool_library_settings WHERE farm_id=${farm}::uuid ORDER BY key LIMIT 256`,
          ),
        ),
      set: (key: string, value: unknown) =>
        ctx.guarded(true, async (sp) => {
          if (!KEY.test(key)) return invalid
          await sp`
            INSERT INTO farm.spool_library_settings (farm_id, key, value, updated_at)
            VALUES (${farm}::uuid, ${key}, ${sp.json(value as never)}, ${ctx.now})
            ON CONFLICT (farm_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at,
              source_key='local',
              source_sha256='0000000000000000000000000000000000000000000000000000000000000000'`
          return ok(true as const)
        }),
      reset: (key: string) =>
        ctx.guarded(true, async (sp) => {
          if (!KEY.test(key)) return invalid
          await sp`DELETE FROM farm.spool_library_settings WHERE farm_id=${farm}::uuid AND key=${key}`
          return ok(true as const)
        }),
    },

    locations: {
      list: () =>
        ctx.guarded(false, async (sp) => {
          const rows = await sp<
            { location: string }[]
          >`SELECT DISTINCT location FROM farm.spools WHERE farm_id=${farm}::uuid AND location IS NOT NULL LIMIT 20000`
          // Code-point order, independent of the database collation.
          return ok(
            rows
              .map((row) => row.location)
              .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
          )
        }),
    },

    renameSpoolFieldValue: (field: string, from: string, to: string) =>
      ctx.guarded(true, async (sp) => {
        if (field === 'location') {
          const rows = await sp`
            UPDATE farm.spools SET location=${to}
            WHERE farm_id=${farm}::uuid AND location=${from} RETURNING id`
          return ok(rows.length)
        }
        const key = field.startsWith('extra.') ? field.slice(6) : ''
        if (!KEY.test(key)) return invalid
        // Extra values are stored as JSON text inside the jsonb document.
        const rows = await sp`
          UPDATE farm.spools
          SET extra = jsonb_set(extra, ARRAY[${key}::text], to_jsonb(${JSON.stringify(to)}::text))
          WHERE farm_id=${farm}::uuid AND extra->>${key}::text = ${JSON.stringify(from)}::text
          RETURNING id`
        return ok(rows.length)
      }),
  }
}
