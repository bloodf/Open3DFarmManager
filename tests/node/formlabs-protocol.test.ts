import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createFormlabsAdapter } from '../../packages/connector/src/formlabs/index.ts'
import { startFormlabsSimulator } from '../../packages/sim-tools/src/formlabs-simulator.ts'

const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/formlabs/devices.json', import.meta.url),
    'utf8',
  ),
)

test('discovers local supported models and reads reported status over HTTP', async (t) => {
  const sim = await startFormlabsSimulator(fixture)
  t.after(sim.close)
  const adapter = createFormlabsAdapter(sim.origin)
  const expected = {
    id: 'fixture-4',
    model: 'Form 4',
    firmware: '1.17.1',
    connection: 'ETHERNET',
    statusText: 'Synthetic vendor status',
    remainingMs: 12500,
    tankId: 'fixture-tank',
    tankMaterialCode: 'FLGPBK05',
    cartridges: [
      {
        id: 'fixture-cartridge',
        materialCode: 'FLGPBK05',
        estimatedDispensedMl: 125.5,
        originalVolumeMl: 1000,
      },
    ],
  }
  assert.deepEqual(await adapter.discover(), [
    expected,
    {
      ...expected,
      id: 'fixture-4l',
      model: 'Form 4L',
      remainingMs: 0,
      tankId: null,
      tankMaterialCode: null,
      cartridges: [],
    },
  ])
  assert.deepEqual(await adapter.readStatus('fixture-4'), expected)
  assert.equal(await adapter.readStatus('fixture-studio'), null)
  sim.setReply({ count: 0, devices: [] })
  assert.equal(await adapter.readStatus('fixture-4'), null)
  assert.deepEqual(sim.requests, [
    'POST /v1/device/discover/',
    ...Array(3).fill('GET /v1/device/list/'),
  ])
})

test('rejects HTTP denial, redirect, disconnect, incomplete body and malformed replies', async (t) => {
  const sim = await startFormlabsSimulator(fixture)
  t.after(sim.close)
  const adapter = createFormlabsAdapter(sim.origin, 500)
  for (const [fault, error] of [
    ['denial', /PreForm HTTP 403/],
    ['redirect', /PreForm HTTP 307/],
    ['disconnect', TypeError],
    ['timeout', { name: 'TimeoutError' }],
    ['malformed', /Malformed PreForm device reply/],
  ] as const) {
    sim.setFault(fault)
    await assert.rejects(adapter.readStatus('fixture-4'), error)
  }
  sim.setFault(undefined)
  const badDevice = {
    ...fixture.devices[0],
    cartridge_data: { broken: { cartridgeEstimatedVolumeDispensed_mL: '125' } },
  }
  sim.setReply({ count: 1, devices: [badDevice] })
  await assert.rejects(adapter.list(), /Malformed PreForm device reply/)
  assert.deepEqual(sim.requests, Array(6).fill('GET /v1/device/list/'))
})
