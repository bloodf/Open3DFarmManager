import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import {
  discoverSdcp,
  parseSdcpDiscovery,
} from '../../packages/connector/src/discovery/sdcp.ts'
import { connectSdcp } from '../../packages/connector/src/sdcp/index.ts'
import { startSdcpSimulator } from '../../packages/sim-tools/src/sdcp-simulator.ts'
import centauri from '../fixtures/sdcp/centauri.json' with { type: 'json' }
import saturn from '../fixtures/sdcp/saturn.json' with { type: 'json' }

test('discovers Saturn and reads board-scoped v3 status with command 0', async (t) => {
  const sim = await startSdcpSimulator(saturn)
  t.after(sim.close)
  const identities = await discoverSdcp({
    target: '127.0.0.1',
    port: sim.discoveryPort,
    timeoutMs: 200,
  })
  assert.equal(identities.length, 1)
  const identity = identities[0]!
  assert.equal(identity.model, saturn.Data.MachineName)
  assert.equal(identity.firmwareVersion, saturn.Data.FirmwareVersion)
  const client = connectSdcp(identity, {
    port: sim.websocketPort,
    now: () => 100,
  })
  t.after(client.close)
  const frame = {
    MainboardID: identity.mainboardId,
    Topic: `sdcp/status/${identity.mainboardId}`,
    Status: saturn.fixtureStatus,
  }
  sim.setStatus({ ...frame, MainboardID: 'wrong-board' })
  for (let i = 0; i < 100 && !sim.requests.length; i++) await setTimeout(10)
  assert.deepEqual(
    sim.requests.map(
      (request) => (request as { Data: { Cmd: number } }).Data.Cmd,
    ),
    [0],
  )
  assert.deepEqual(client.command(320), { ok: false, reason: 'unsupported' })
  assert.equal(client.snapshot(), undefined)
  sim.publish(frame)
  for (let i = 0; i < 100 && !client.snapshot(); i++) await setTimeout(10)
  assert.deepEqual(client.snapshot(), {
    state: 'printing',
    currentLayer: 20,
    totalLayer: 200,
    progress: 0.1,
    observedAt: 100,
  })
})

test('rejects Centauri even when discovery supplies the required v3 fields', () => {
  const discovery = {
    Id: centauri.Id,
    Data: { ...saturn.Data, ...centauri.Data },
  }
  assert.equal(
    parseSdcpDiscovery(Buffer.from(JSON.stringify(discovery)), '127.0.0.1'),
    undefined,
  )
})

test('rejects legacy SDCP and unsupported models before opening a socket', () => {
  const identity = parseSdcpDiscovery(
    Buffer.from(JSON.stringify(saturn)),
    '127.0.0.1',
  )!
  assert.throws(
    () => connectSdcp({ ...identity, protocolVersion: 'V1.0.0' }),
    /Unsupported SDCP protocol version/,
  )
  assert.throws(
    () => connectSdcp({ ...identity, model: centauri.Data.MachineName }),
    /Unsupported SDCP model/,
  )
})
