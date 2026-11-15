import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { qualifyAnycubic } from '../../scripts/qualify/anycubic.ts'

test('Anycubic defaults to 9883 and authenticates with LAN credentials', async () => {
  const credentials = {
    username: 'lan-user',
    password: 'synthetic-lan-password',
  }
  const sim = await startAnycubicSimulator({
    port: 9883,
    initialState: 'RUNNING',
    credentials,
  })
  const trust = {
    caPem: sim.syntheticTrust,
    pinSha256: createHash('sha256')
      .update(new X509Certificate(sim.syntheticTrust).raw)
      .digest('hex'),
  }
  try {
    const options = { vendor: 'anycubic', host: sim.host, timeoutMs: 1000 }
    const rejected = await qualifyAnycubic(options, {
      ...credentials,
      ...trust,
      password: 'wrong',
    })
    assert.equal(rejected.telemetry.observed, false)
    const accepted = await qualifyAnycubic(options, {
      ...credentials,
      ...trust,
    })
    assert.equal(accepted.telemetry.observed, true)
    assert.ok(accepted.telemetry.fields.includes('progress'))
  } finally {
    await sim.close()
  }
})
