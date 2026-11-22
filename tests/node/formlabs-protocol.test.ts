import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  connectFormlabs,
  isSupportedFormlabsModel,
} from '../../packages/connector/src/formlabs/index.ts'
import { startFormlabsSimulator } from '../../packages/sim-tools/src/formlabs-simulator.ts'
import fixture from '../fixtures/formlabs/devices.json' with { type: 'json' }

test('reads the synthetic Form 4 family list using the read-only Local API', async (t) => {
  const sim = await startFormlabsSimulator()
  t.after(sim.close)
  sim.setResponse(fixture)
  const adapter = connectFormlabs({
    host: '127.0.0.1',
    port: sim.port,
    now: () => 100,
  })
  const result = await adapter.refresh()
  assert.deepEqual(
    result.devices.filter(({ product_name }) =>
      isSupportedFormlabsModel(product_name),
    ),
    ['fixture-4', 'fixture-4l', 'fixture-remote'].map((id, index) => ({
      id,
      product_name: index === 1 ? 'Form 4L' : 'Form 4',
      status: 'Synthetic vendor status',
      is_connected: true,
      connection_type: index === 2 ? 'REMOTE' : 'ETHERNET',
      ip_address: '192.0.2.1',
      firmware_version: '1.17.1',
    })),
  )
  assert.equal(result.printerObservedAt, null)
  assert.equal(result.retrievedAt, 100)
  assert.deepEqual(adapter.command('discover'), {
    ok: false,
    reason: 'unsupported',
  })
  sim.setResponse({ count: 0, devices: [] })
  assert.deepEqual((await adapter.refresh()).devices, [])
  assert.deepEqual(sim.requests, Array(2).fill('GET /devices/'))
})

test('clears the previous reading after denial, redirect or invalid lists', async (t) => {
  const sim = await startFormlabsSimulator()
  t.after(sim.close)
  const adapter = connectFormlabs({ host: '127.0.0.1', port: sim.port })
  for (const [reply, code] of [
    [fixture, 403],
    [fixture, 307],
    [{ ...fixture, count: 1 }, 200],
    [{ count: 1, devices: [{}] }, 200],
  ] as const) {
    sim.setResponse(fixture)
    await adapter.refresh()
    sim.setResponse(reply, code)
    await assert.rejects(adapter.refresh())
    assert.equal(adapter.snapshot(), undefined)
  }
  assert.deepEqual(sim.requests, Array(8).fill('GET /devices/'))
})
