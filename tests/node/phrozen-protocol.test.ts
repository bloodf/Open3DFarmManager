import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectPhrozen } from '../../packages/connector/src/phrozen/index.ts'
import { startPhrozenSimulator } from '../../packages/sim-tools/src/phrozen-simulator.ts'
import fixture from '../fixtures/phrozen/revo-14k-v153.json' with { type: 'json' }

test('discovers Revo and reads raw status from the provisioned address', async (t) => {
  const sim = await startPhrozenSimulator(fixture)
  t.after(sim.close)
  const printer = await connectPhrozen('127.0.0.1', sim)
  assert.deepEqual(printer.identity, {
    id: '0123456789abcdef0123456789abcdef',
    board: '000000000001d354',
    model: 'Sonic Mighty Revo',
    firmware: 'V153',
  })
  assert.equal(printer.authentication, 'none')
  assert.deepEqual(await printer.readStatus(), fixture.fixtureStatus)
  assert.deepEqual(sim.commands, [0])
})

for (const [fault, error] of [
  ['denied', /denied status \(Ack 1\)/],
  ['disconnect', /Phrozen disconnected/],
  ['timeout', /Phrozen status timeout/],
  ['malformed', SyntaxError],
  ['wrong-board', /Phrozen status timeout/],
] as const) {
  test(`fails closed after ${fault} without replay`, async (t) => {
    const sim = await startPhrozenSimulator(fixture, fault)
    t.after(sim.close)
    const printer = await connectPhrozen('127.0.0.1', {
      ...sim,
      timeoutMs: 300,
    })
    await assert.rejects(printer.readStatus(), error)
    assert.deepEqual(sim.commands, [0])
  })
}

for (const attributes of [
  { MachineName: 'Sonic Mighty Revo 16K' },
  { ProtocolVersion: 'V1.0.0' },
  { FirmwareVersion: 'V999' },
  { FirmwareVersion: 'V122' },
]) {
  test(`rejects unsupported discovery ${JSON.stringify(attributes)}`, async (t) => {
    const sim = await startPhrozenSimulator({
      ...fixture,
      Data: { ...fixture.Data, ...attributes },
    })
    t.after(sim.close)
    await assert.rejects(
      connectPhrozen('127.0.0.1', sim),
      /Unsupported Phrozen SDCP/,
    )
    assert.deepEqual(sim.commands, [])
  })
}
