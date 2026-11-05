import {
  validateMigrationHistory,
  type migrationCatalog,
} from '../../scripts/db/migrations.ts'

export function assertSignallingCatalog(
  catalog: ReturnType<typeof migrationCatalog>,
  history: unknown,
  rtcFixture: boolean,
): number {
  if (
    catalog.length < 17 ||
    catalog[16]?.id !== '0017_signalling_authorization' ||
    (!rtcFixture && catalog.length !== 17)
  )
    throw new Error('Unexpected signalling migration catalog')
  const applied = validateMigrationHistory(catalog, history)
  if (applied !== catalog.length)
    throw new Error('Complete signalling migration journal required')
  return applied
}
