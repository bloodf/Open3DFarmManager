// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic, reference-derived reports (nothing here was captured). Report
// shapes: bloodf/OrcaSlicer@d0a76d08d3493352c6c575ee242e2d71356e400e
// src/slic3r/Utils/KobraX.cpp (`State::apply`, `on_info`). The `info.lights`
// array has no cited source. No socket is opened.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  kobraXControls,
  type KobraXControlEvidence,
} from '../../packages/connector/src/kobra-x/control-support.ts'
import { createKobraXFacts } from '../../packages/connector/src/kobra-x/facts.ts'
import { parseKobraXReport } from '../../packages/connector/src/kobra-x/requests.ts'
import { createKobraXStatus } from '../../packages/connector/src/kobra-x/status.ts'
import type { RawPrinterObservation } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { createKobraXCollection } from '../../packages/connector/src/runtime/kobra-x-collection.ts'

const accessoryActions = [
  'set_fan',
  'set_light',
  'load_filament',
  'unload_filament',
] as const

const full = {
  state: 'free',
  fan_speed_pct: 0,
  lights: [{ type: 3, status: 0, brightness: 0 }],
  multi_color_box: [{ id: 0, loaded_slot: -1, slots: [] }],
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'kx-stale-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const clientCertFile = join(directory, 'client.json')
  writeFileSync(
    clientCertFile,
    JSON.stringify({
      version: 1,
      format: 'pem',
      subject: 'CN=AnycubicSlicer',
      commonName: 'AnycubicSlicer',
      notBefore: 1,
      notAfter: Date.now() + 3_600_000,
      notBeforeIso: 'synthetic',
      notAfterIso: 'synthetic',
      fingerprintSha256: 'a'.repeat(64),
      certificatePem: 'synthetic',
      keyPem: 'synthetic',
    }),
    { mode: 0o600 },
  )
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  let mono = 1000
  t.mock.method(performance, 'now', () => mono)
  const status = createKobraXStatus('synthetic', '127.0.0.1')
  const facts = createKobraXFacts()
  let evidence: KobraXControlEvidence | undefined
  const published: (KobraXControlEvidence | undefined)[] = []
  const observed: RawPrinterObservation[] = []
  const unavailable: number[] = []
  const controller = new AbortController()
  const collection = createKobraXCollection({
    binding: {
      printerKey: 'synthetic',
      host: '127.0.0.1',
      modelId: '20030',
      deviceId: 'synthetic',
      clientCertFile,
      pinSha256: 'a'.repeat(64),
    },
    signal: controller.signal,
    pollMs: 500,
    connect: (async () => ({
      snapshot: status.snapshot,
      facts: facts.get,
      identity: { deviceId: 'synthetic', modelId: '20030', name: 'synthetic' },
      close: async () => {},
    })) as unknown as NonNullable<
      Parameters<typeof createKobraXCollection>[0]['connect']
    >,
    onObservation: (value) => observed.push(value),
    onUnavailable: (epoch) => unavailable.push(epoch),
    onControlEvidence(next) {
      evidence = next
      published.push(next)
    },
  })
  t.after(async () => {
    controller.abort()
    await collection.done
  })
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  async function advance(ms: number) {
    for (let passed = 0; passed < ms; passed += 500) {
      mono += 500
      t.mock.timers.tick(500)
      await flush()
    }
  }
  async function report(
    type: string,
    data: Record<string, unknown>,
    action = 'report',
  ) {
    const message = { type, action, data, state: 'done', code: 200 }
    status.report(type, message)
    facts.report(parseKobraXReport(type, message)!)
    await advance(500)
  }
  await flush()
  return {
    advance,
    report,
    status,
    published,
    observed,
    unavailable,
    evidence: () => evidence,
    offered: () =>
      accessoryActions.filter((action) =>
        kobraXControls(evidence).includes(action),
      ),
  }
}

test('30 s of silence withdraws light, fan and ACE until a fresh report', async (t) => {
  const f = await fixture(t)
  await f.report('info', full)
  assert.deepEqual(f.offered(), [...accessoryActions])

  await f.advance(29_000)
  assert.deepEqual(f.offered(), [...accessoryActions])
  assert.equal(f.unavailable.length, 0)

  await f.advance(1_000)
  assert.equal(f.evidence(), undefined)
  assert.deepEqual(f.offered(), [])
  assert.equal(f.unavailable.length, 1)
  const publications = f.published.length
  const observations = f.observed.length

  // Later polls read the same old snapshot and facts: nothing comes back.
  await f.advance(20_000)
  assert.equal(f.published.length, publications)
  assert.equal(f.observed.length, observations)
  assert.deepEqual(f.offered(), [])
  assert.equal(f.unavailable.length, 1)

  await f.report('info', full)
  assert.deepEqual(f.offered(), [...accessoryActions])
  assert.equal(f.observed.length, observations + 1)
  assert.equal(f.observed.at(-1)!.epoch, 2)
})

test('light and fan evidence clears on the same connection once info omits them', async (t) => {
  const f = await fixture(t)
  await f.report('info', full)
  assert.deepEqual(f.evidence(), { ace: true, light: true, fan: true })

  // Partial reports say nothing about what the printer carries.
  await f.report('tempature', { curr_nozzle_temp: 25 }, 'query')
  await f.report('info', { mac: '02:00:00:00:20:30' }, 'net')
  await f.report('status', { state: 'free' }, 'query')
  assert.deepEqual(f.evidence(), { ace: true, light: true, fan: true })

  await f.report('info', { state: 'free', lights: [], fan_speed_pct: 0 })
  assert.deepEqual(f.evidence(), { ace: true, light: false, fan: true })
  assert.equal(f.status.snapshot().light, undefined)

  await f.report('info', { state: 'free', lights: [] })
  assert.deepEqual(f.evidence(), { ace: true, light: false, fan: false })
  assert.equal(f.status.snapshot().fans, undefined)
  assert.equal(f.observed.at(-1)!.printer.light, undefined)
  assert.equal(f.observed.at(-1)!.printer.fans, undefined)
  assert.deepEqual(f.offered(), ['load_filament', 'unload_filament'])
  assert.equal(f.unavailable.length, 0)

  await f.report('info', full)
  assert.deepEqual(f.offered(), [...accessoryActions])
})

test('a busy info report keeps the fan it names under settings', async (t) => {
  const f = await fixture(t)
  await f.report('info', {
    state: 'busy',
    settings: { fan_speed_pct: 40 },
    lights: full.lights,
  })
  assert.deepEqual(f.status.snapshot().fans, { part: 40 })
  assert.equal(f.evidence()?.fan, true)
})
