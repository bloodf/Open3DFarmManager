import { readVersionedRuntimeConfig } from '../packages/connector/src/config/version.ts'

const path = process.argv[2]
if (!path || process.argv.length !== 3) {
  console.error(
    'Usage: node scripts/connector-config-migrate.ts <runtime-config>',
  )
  process.exitCode = 1
} else {
  try {
    readVersionedRuntimeConfig(path)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Migration failed')
    process.exitCode = 1
  }
}
