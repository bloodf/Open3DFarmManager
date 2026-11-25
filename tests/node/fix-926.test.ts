import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('sandbox seeds an enabled library with its dedicated database role', async () => {
  const seed = await readFile('scripts/sandbox-seed.ts', 'utf8')
  assert.match(seed, /sandbox_library:\s*'farm_library'/)
  assert.match(seed, /'NUXT_LIBRARY_ENABLED=true'/)
  assert.match(
    seed,
    /'NUXT_LIBRARY_DATABASE_URL='\s*\+\s*internalUrl\('sandbox_library'\)/,
  )
})
