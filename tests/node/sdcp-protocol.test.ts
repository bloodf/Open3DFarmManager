import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectSdcp } from '../../packages/connector/src/sdcp/index.ts'
import { startSdcpSimulator } from '../../packages/sim-tools/src/sdcp-simulator.ts'
import centauri from '../fixtures/sdcp/centauri.json' with { type: 'json' }
import saturn from '../fixtures/sdcp/saturn.json' with { type: 'json' }

for (const [fixture, kind] of [
  [centauri, 'fdm'],
  [saturn, 'resin'],
] as const) {
  test(`reads SDCP v3 ${kind} status over UDP and WebSocket`, async (t) => {
    const sim = await startSdcpSimulator(fixture)
    t.after(sim.close)
    const client = await connectSdcp('127.0.0.1', sim)
    assert.equal(client.kind, kind)
    assert.equal(client.authentication, 'none')
    assert.equal(
      client.cameraUrl,
      kind === 'fdm' ? 'http://127.0.0.1:3031/video' : undefined,
    )
    assert.deepEqual(await client.readStatus(), fixture.fixtureStatus)
    assert.deepEqual(sim.commands, [0])
  })
}

test('reads Saturn V1.5.6 history with command 320', async (t) => {
  const sim = await startSdcpSimulator(saturn)
  t.after(sim.close)
  const client = await connectSdcp('127.0.0.1', sim)
  assert.equal(client.historySupported, true)
  assert.deepEqual(await client.readHistoryIds(), ['fixture-task'])
  assert.deepEqual(sim.commands, [320])
})

test('stock Centauri V1.1.46 history sends no command', async (t) => {
  const sim = await startSdcpSimulator(centauri)
  t.after(sim.close)
  const client = await connectSdcp('127.0.0.1', sim)
  assert.equal(client.historySupported, false)
  await assert.rejects(client.readHistoryIds(), /unsupported/)
  assert.deepEqual(sim.commands, [])
})

for (const [fault, expected] of [
  ['denied', /denied command 0/],
  ['disconnect', /disconnected/],
  ['timeout', /response timeout/],
  ['malformed', SyntaxError],
  ['wrong-board', /response timeout/],
] as const) {
  test(`SDCP handles ${fault} with one request`, async (t) => {
    const sim = await startSdcpSimulator(saturn, fault)
    t.after(sim.close)
    const client = await connectSdcp('127.0.0.1', { ...sim, timeoutMs: 300 })
    await assert.rejects(client.readStatus(), expected)
    assert.deepEqual(sim.commands, [0])
  })
}

test('rejects legacy SDCP without attempting WebSocket', async (t) => {
  const sim = await startSdcpSimulator({
    ...saturn,
    Data: {
      Attributes: { ...saturn.Data.Attributes, ProtocolVersion: 'V1.0.0' },
    },
  } as typeof saturn)
  t.after(sim.close)
  await assert.rejects(
    connectSdcp('127.0.0.1', sim),
    /Unsupported SDCP version/,
  )
  assert.deepEqual(sim.commands, [])
})

test('history remains disabled on an unobserved firmware', async (t) => {
  const sim = await startSdcpSimulator({
    ...centauri,
    Data: {
      ...centauri.Data,
      FirmwareVersion: 'V1.2.0',
      ProtocolVersion: 'V3.0.0',
    },
  } as typeof centauri)
  t.after(sim.close)
  const client = await connectSdcp('127.0.0.1', sim)
  assert.equal(client.historySupported, false)
  await assert.rejects(client.readHistoryIds(), /unsupported/)
  assert.deepEqual(sim.commands, [])
})
