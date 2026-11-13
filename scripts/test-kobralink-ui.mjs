import { spawnSync } from 'node:child_process'
const result = spawnSync(
  'pnpm',
  ['exec', 'playwright', 'test', '--config=playwright.kobralink.config.ts'],
  { stdio: 'inherit', env: process.env },
)
process.exit(result.status ?? 1)
