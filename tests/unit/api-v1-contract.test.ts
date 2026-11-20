import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('v1 routes and reference client match the OpenAPI contract', () => {
  // Vitest provides the module mocks used to load the real Nuxt handlers.
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('vitest.mjs', import.meta.resolve('vitest/package.json')),
      ),
      'run',
      'tests/unit/api-v1-contract.vitest.test.ts',
    ],
    { cwd: new URL('../../', import.meta.url), stdio: 'inherit' },
  )
})
