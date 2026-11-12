import {
  catalogThrough,
  validateMigrationHistory,
  type migrationCatalog,
} from '../../scripts/db/migrations.ts'

/**
 * Every fixture mode requires the complete current catalog to be applied.
 * Signalling authorization must be present; its position is derived from the
 * catalog, so later migrations never break the read-only acceptance row.
 */
export function assertSignallingCatalog(
  catalog: ReturnType<typeof migrationCatalog>,
  history: unknown,
): number {
  catalogThrough(catalog, '0017_signalling_authorization')
  const applied = validateMigrationHistory(catalog, history)
  if (applied !== catalog.length)
    throw new Error('Complete signalling migration journal required')
  return applied
}
