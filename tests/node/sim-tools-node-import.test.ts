import test from 'node:test'
import assert from 'node:assert/strict'

// sim:verify runs under plain Node, which rejects JSON imports without an
// import attribute before any simulator request is made.
test('Spoolman seeder module loads under Node', async () => {
  const { seedSpoolman } =
    await import('../../packages/sim-tools/src/spoolman.ts')
  assert.equal(typeof seedSpoolman, 'function')
})
