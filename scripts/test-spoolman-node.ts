// Read-only qualification against a parent-owned disposable synthetic fixture.
import assert from 'node:assert/strict'
import { qualificationScope } from './spoolman-qualification-context.ts'
import seed from '../infra/sim/spoolman/seed.json' with { type: 'json' }
import { createLoopbackSpoolmanReader } from '../packages/connector/src/spoolman/http-read.ts'

const origin = process.env.SPOOLMAN_SYNTHETIC_TEST_ORIGIN
if (!origin || process.env.SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE !== 'yes')
  throw new Error('Explicit disposable synthetic Spoolman origin required')

const context = { ...qualificationScope, limit: 200 }
const read = (limit: number) =>
  createLoopbackSpoolmanReader({
    origin,
    context: { ...context, limit },
    timeoutMs: 10000,
  })()

const baseline = await read(200)
assert.equal(baseline.items.length, 6)
const ids = baseline.items.map((item) => item.id)
assert.deepEqual(
  ids,
  [...ids].sort((a, b) => a - b),
)
assert.equal(new Set(ids).size, 6)
assert.deepEqual(
  baseline.items.map((item) => item.remaining_weight),
  [1000, 900, 800, 700, 600, 500],
)
const expectedAssociations = seed.spools.map((spool) => {
  const filament = seed.filaments[spool.filament]
  assert.ok(filament, 'Invalid fixture filament reference')
  const vendor = seed.vendors[filament.vendor]
  assert.ok(vendor, 'Invalid fixture vendor reference')
  return { filament: filament.name, vendor: vendor.name }
})
assert.deepEqual(
  baseline.items.map((item) => ({
    filament: item.filament.name,
    vendor: item.filament.vendor?.name,
  })),
  expectedAssociations,
)
const filamentIds = baseline.items.map((item) => item.filament.id)
const vendorIds = baseline.items.map((item) => item.filament.vendor?.id)
assert.equal(new Set(filamentIds).size, 4)
assert.deepEqual(filamentIds, [
  filamentIds[0],
  filamentIds[1],
  filamentIds[2],
  filamentIds[3],
  filamentIds[0],
  filamentIds[1],
])
assert.notEqual(vendorIds[0], undefined)
assert.notEqual(vendorIds[2], undefined)
assert.notEqual(vendorIds[0], vendorIds[2])
assert.deepEqual(vendorIds, [
  vendorIds[0],
  vendorIds[0],
  vendorIds[2],
  vendorIds[2],
  vendorIds[0],
  vendorIds[0],
])
assert.equal(baseline.items.filter((item) => item.archived).length, 1)
assert.equal(baseline.items[0]?.archived, true)
for (const limit of [1, 2, 4, 200]) {
  const result = await read(limit)
  assert.deepEqual(result.items, baseline.items)
  assert.equal(result.farmId, context.farmId)
  assert.equal(result.serviceId, context.serviceId)
}
console.log(
  JSON.stringify({
    result: 'passed',
    runtime: process.version,
    spools: 6,
    pageLimits: [1, 2, 4, 200],
    archivedIncluded: true,
  }),
)
