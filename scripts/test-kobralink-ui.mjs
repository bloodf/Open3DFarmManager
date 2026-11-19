import { spawnSync } from 'node:child_process'
const result = spawnSync(
  'npx',
  ['playwright', 'test', '--config=playwright.kobralink.config.ts'],
  { stdio: 'inherit', env: process.env },
)
process.exit(result.status ?? 1)
