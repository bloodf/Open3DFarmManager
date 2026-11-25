import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'
import type { RawPrinterObservation } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'

test('a stopped job and later idle report have no progress', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rv-897-'))
  const passwordFile = join(directory, 'password.json')
  writeFileSync(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const controller = new AbortController()
  const observations: RawPrinterObservation[] = []
  let report: (payload: unknown) => void = () => {}
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
    onUnavailable() {},
    transport(options) {
      report = (payload) =>
        options.onReport(Buffer.from(JSON.stringify(payload)))
      return { done: Promise.resolve(), close: async () => {} }
    },
  })
  t.after(async () => {
    controller.abort()
    await collection.done
    rmSync(directory, { recursive: true, force: true })
  })
  report({ data: { state: 'printing', progress: 40 } })
  assert.equal(observations.at(-1)?.printer.progress, 0.4)
  report({ type: 'print', action: 'stop', state: 'stoped', code: 10601 })
  assert.equal(observations.at(-1)?.printer.state, 'idle')
  assert.equal(observations.at(-1)?.printer.progress, undefined)
  const count = observations.length
  report({ data: { state: 'free', project: null } })
  assert.equal(observations.length, count + 1)
  assert.equal(observations.at(-1)?.printer.progress, undefined)
})
