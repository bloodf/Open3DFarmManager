import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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
      // Form4FamilyDevice in PreForm API v1.0.0-alpha.1; the fixture's values.
      estimated_print_time_remaining_ms: index === 1 ? 0 : 12500,
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

for (const fault of ['disconnect', 'incomplete'] as const) {
  test(`clears Formlabs snapshot on ${fault}`, async (t) => {
    let fail = false
    const requests: string[] = []
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`)
      if (!fail) {
        res.end(JSON.stringify(fixture))
        return
      }
      if (fault === 'disconnect') {
        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'Content-Length': '1000' })
      res.write('{')
      res.socket?.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
    )
    const adapter = connectFormlabs({
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
      timeoutMs: 500,
    })
    await adapter.refresh()
    fail = true
    await assert.rejects(adapter.refresh(), TypeError)
    assert.equal(adapter.snapshot(), undefined)
    assert.deepEqual(requests, ['GET /devices/', 'GET /devices/'])
  })
}
