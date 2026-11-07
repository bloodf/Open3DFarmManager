// Read-only qualification against a parent-owned disposable synthetic fixture.
import assert from 'node:assert/strict'
import { createLoopbackSpoolmanReader } from '../packages/connector/src/spoolman/http-read.ts'

const origin = process.env.SPOOLMAN_SYNTHETIC_TEST_ORIGIN
if (!origin || process.env.SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE !== 'yes')
  throw new Error('Explicit disposable synthetic Spoolman origin required')

const context = {
  farmId: '00000000-0000-4000-8000-000000000001',
  serviceId: '00000000-0000-4000-8000-000000000002',
  limit: 200,
}
const read = (limit: number) =>
  createLoopbackSpoolmanReader({
    origin,
    context: { ...context, limit },
    timeoutMs: 10000,
  })()

const baseline = await read(200)
assert.equal(baseline.items.length, 6)
const ids = baseline.items.map((item) => item.id)
assert.deepEqual(ids, [...ids].sort((a, b) => a - b))
assert.equal(new Set(ids).size, 6)
assert.deepEqual(baseline.items.map((item) => item.remaining_weight), [1000, 900, 800, 700, 600, 500])
assert.equal(new Set(baseline.items.map((item) => item.filament.id)).size, 4)
assert.equal(new Set(baseline.items.map((item) => item.filament.vendor?.id)).size, 2)
assert.equal(baseline.items.filter((item) => item.archived).length, 1)
assert.equal(baseline.items[0]?.archived, true)
for (const limit of [1, 2, 4, 200]) {
  const result = await read(limit)
  assert.deepEqual(result.items, baseline.items)
  assert.equal(result.farmId, context.farmId)
  assert.equal(result.serviceId, context.serviceId)
}
console.log(JSON.stringify({ result: 'passed', runtime: process.version, spools: 6, pageLimits: [1, 2, 4, 200], archivedIncluded: true }))
