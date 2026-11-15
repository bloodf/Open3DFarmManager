import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'

test('partial reports keep Anycubic available after once-only fields expire', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 100
  t.mock.method(performance, 'now', () => now)
  const directory = mkdtempSync(join(tmpdir(), 'anycubic-staleness-'))
  const passwordFile = join(directory, 'password.json')
  writeFileSync(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const controller = new AbortController()
  let report: (payload: unknown) => void = () => {}
  const observations: unknown[] = []
  const unavailable: number[] = []
  const collection = createAnycubicCollection({
    binding: {
      printerKey: 'a',
      host: '127.0.0.1',
      port: 9883,
      modelId: '20024',
      deviceId: 'SYNTHETIC',
      username: 'test',
      passwordFile,
    },
    signal: controller.signal,
    onObservation: (value) => observations.push(value),
    onUnavailable: (epoch) => unavailable.push(epoch),
    transport(options) {
      report = (payload) =>
        options.onReport(Buffer.from(JSON.stringify(payload)))
      return { done: Promise.resolve(), close: async () => {} }
    },
  })
  try {
    report({
      data: {
        state: 'printing',
        progress: 10,
        filename: 'part.gcode',
        total_layers: 100,
      },
    })
    for (let i = 1; i <= 8; i++) {
      now += 1000
      t.mock.timers.tick(1000)
      report({ data: { state: 'printing', progress: 10 + i } })
    }
    assert.equal(observations.length, 9)
    assert.deepEqual(unavailable, [])
    now += 5000
    t.mock.timers.tick(5000)
    assert.deepEqual(unavailable, [1])
  } finally {
    controller.abort()
    await collection.done
    rmSync(directory, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})
