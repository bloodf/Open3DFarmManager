import {
  validateMigrationHistory,
  type migrationCatalog,
} from './migrations.ts'

const expectedIds = [
  '0001_connector_enrollments',
  '0002_telemetry_events',
  '0003_runtime_capabilities',
  '0004_account_sessions',
  '0005_password_auth',
  '0006_farm_memberships',
  '0007_pairing_requests',
  '0008_pairing_proofs',
  '0009_pairing_proof_gates',
  '0010_connector_credentials',
  '0011_connector_revocations',
  '0012_connector_inventory',
  '0013_browser_device_registry',
  '0014_connector_credential_proofs',
  '0015_printer_ownership',
  '0016_telemetry_operation_proofs',
]
/** Require the exact current 0001–0016 fixture; later source files stay unapplied. */
export function validatePairingHttpCatalog(
  catalog: ReturnType<typeof migrationCatalog>,
  history: unknown,
): void {
  const prefix = catalog.slice(0, expectedIds.length)
  if (
    prefix.length !== expectedIds.length ||
    prefix.some((entry, index) => entry.id !== expectedIds[index]) ||
    validateMigrationHistory(prefix, history) !== expectedIds.length
  )
    throw new Error('Pairing HTTP fixture requires the exact 0001–0016 journal')
}
