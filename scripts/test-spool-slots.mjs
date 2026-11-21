// Run the disposable PostgreSQL feature-schema evidence, including slot
// uniqueness and farm-isolation checks from migration 0089.
import { spawnSync } from 'node:child_process'

const result = spawnSync(process.execPath, ['scripts/test-spool-features-schema.mjs'], {
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
