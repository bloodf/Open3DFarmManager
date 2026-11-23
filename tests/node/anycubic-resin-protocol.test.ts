import assert from 'node:assert/strict'
import test from 'node:test'
import { createPhotonResinAdapter } from '../../packages/connector/src/anycubic-resin/index.ts'
import { startPhotonHandshakeSimulator } from '../../packages/sim-tools/src/anycubic-resin-simulator.ts'
import fixture from '../fixtures/anycubic-resin/p1-max-handshake.json' with { type: 'json' }

test('discovers a P1 Max and negotiates ephemeral credentials at the configured IP', async (t) => {
  const simulator = await startPhotonHandshakeSimulator(fixture)
  t.after(() => simulator.close())
  const adapter = createPhotonResinAdapter(simulator)
  assert.deepEqual(await adapter.discover(), {
    model: 'Anycubic Photon P1 Max',
    modelId: '132',
    serial: 'FIXTURE-P1-MAX',
    mode: 'net',
  })
  assert.equal(simulator.exchanges(), 0)
  await assert.rejects(
    adapter.negotiateBroker('other-machine'),
    /identity or mode mismatch/,
  )
  assert.equal(simulator.exchanges(), 0)
  assert.deepEqual(await adapter.negotiateBroker('FIXTURE-P1-MAX'), {
    host: '127.0.0.1',
    port: 8883,
    deviceId: 'fixture-device',
    clientId: 'clientId',
    username: 'fixture-user',
    password: 'fixture-password',
  })
  assert.equal(simulator.exchanges(), 1)
})

for (const [fault, message] of [
  ['deny', /authentication denied/],
  ['disconnect', /request failed/],
  ['timeout', /timed out/],
  ['malformed', /Malformed Photon LAN reply/],
  ['bad-ciphertext', /Malformed Photon LAN credentials/],
] as const) {
  test(`surfaces ${fault} without repeating the credential exchange`, async (t) => {
    const simulator = await startPhotonHandshakeSimulator({ ...fixture, fault })
    t.after(() => simulator.close())
    const adapter = createPhotonResinAdapter({ ...simulator, timeoutMs: 500 })
    await assert.rejects(adapter.negotiateBroker('FIXTURE-P1-MAX'), message)
    assert.equal(simulator.exchanges(), 1)
  })
}

test('rejects a different model before credential exchange', async (t) => {
  const simulator = await startPhotonHandshakeSimulator({
    ...fixture,
    identity: {
      ...fixture.identity,
      modelId: '131',
      modelName: 'Anycubic Photon P1',
    },
  })
  t.after(() => simulator.close())
  await assert.rejects(
    createPhotonResinAdapter(simulator).negotiateBroker('FIXTURE-P1-MAX'),
    /Unsupported Photon LAN identity/,
  )
  assert.equal(simulator.exchanges(), 0)
})
