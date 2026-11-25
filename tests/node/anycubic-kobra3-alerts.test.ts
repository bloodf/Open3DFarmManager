// SPDX-License-Identifier: AGPL-3.0-or-later
// Kobra 3 (model 20024) printer alerts, and the Kobra X state and camera facts
// that share them. Synthetic, reference-derived reports (nothing here was
// captured; only a loopback simulator is contacted), from
// bloodf/kobracontrol@c414db4f36d4c96f2b232c368ad6cfe56e3d0408:
// - src/kobracontrol/kobra.py `CANCEL_CODES`, `PRE_PRINT`, `succeeded`,
//   `State._on_print`.
// - tests/test_kobra.py: 10111 "abnormal end of task", 10601 user stop and the
//   1203 "filament runout" pause.
// - tests/test_models.py `K3_INFO` (re-typed there from Rinkhals; addresses
//   replaced here).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { selectAnycubicCamera } from '../../packages/connector/src/anycubic/camera.ts'
import { createAnycubicLanClient } from '../../packages/connector/src/anycubic/index.ts'
import { anycubicPrinterDetail } from '../../packages/connector/src/anycubic/printer-detail.ts'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'
import {
  parseKobraXReport,
  reportRefusal,
} from '../../packages/connector/src/kobra-x/requests.ts'
import { createKobraXStatus } from '../../packages/connector/src/kobra-x/status.ts'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'
import type { RawPrinterObservation } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'

const ended =
  'A impressora encerrou a impressão (código 10111): abnormal end of task'
const paused = 'A impressora pausou a impressão (código 1203): filament runout'

const print = (
  state: string,
  extra: Record<string, unknown> = {},
  data: unknown = { filename: '/part.gcode', progress: 0 },
) => ({ type: 'print', action: 'start', state, code: 200, data, ...extra })
const fault = { action: 'stop', code: 10111, msg: 'abnormal end of task' }
const runout = { action: 'pause', code: 1203, msg: 'filament runout' }
const decode = (value: unknown) =>
  decodeAnycubicReport(Buffer.from(JSON.stringify(value))) as Record<
    string,
    unknown
  >

test('print/report separates a printer fault from a cancel and a refusal', () => {
  assert.deepEqual(decode(print('stoped', fault)), {
    kind: 'observation',
    state: 'error',
    filename: 'part.gcode',
    alert: { kind: 'ended', message: ended },
  })
  // A fault without a payload still counts.
  assert.equal(decode(print('stoped', fault, null)).state, 'error')
  for (const code of [undefined, 0, 200, 10601]) {
    const report = decode(print('stoped', { action: 'stop', code }))
    assert.equal(report.state, 'idle', String(code))
    assert.equal(report.alert, undefined)
  }
  assert.deepEqual(decode(print('paused', runout)).alert, {
    kind: 'paused',
    message: paused,
  })
  assert.equal(decode(print('paused', { action: 'pause' })).alert, undefined)
  for (const type of ['print', 'light'])
    assert.deepEqual(
      decode({
        type,
        action: 'pause',
        state: 'failed',
        code: 10020,
        data: { state: 'paused', type: 2, status: 1 },
      }),
      { kind: 'ignored' },
    )
  assert.equal(
    decode(print('stoped', { ...fault, action: 'getSliceParam' })).alert,
    undefined,
  )
  const long = decode(
    print('stoped', { ...fault, msg: `a\u0000b${'x'.repeat(300)}` }),
  ).alert as { message: string }
  assert.ok(long.message.length <= 128 && !long.message.includes('\u0000'))
})

test('an idle Kobra 3 info report carries state and nested temperatures', () => {
  const report = decode({
    type: 'info',
    action: 'report',
    state: 'done',
    code: 200,
    data: {
      version: '2.3.5.3',
      state: 'free',
      project: null,
      temp: { curr_hotbed_temp: 23, curr_nozzle_temp: 28 },
      fan_speed_pct: 0,
    },
  })
  assert.equal(report.state, 'idle')
  // The report has no progress, and none is made up.
  assert.equal(report.progress, undefined)
  assert.equal(report.toolTemperatureCelsius, 28)
  assert.equal(report.bedTemperatureCelsius, 23)
})

test('the collector keeps a Kobra 3 alert until the printer moves on', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'kobra3-alerts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const passwordFile = join(directory, 'password.json')
  writeFileSync(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const sim = await startAnycubicSimulator({
    serial: '20024/device',
    reportIntervalMs: 60_000,
  })
  const controller = new AbortController()
  const seen: RawPrinterObservation['printer'][] = []
  const collector = createAnycubicCollection({
    binding: {
      printerKey: 'fixture',
      host: sim.host,
      port: sim.port,
      modelId: '20024',
      deviceId: 'device',
      username: 'synthetic',
      passwordFile,
    },
    signal: controller.signal,
    transport: (options) =>
      createAnycubicLanClient({ ...options, caPem: sim.syntheticTrust }),
    onObservation: (value) => seen.push(value.printer),
    onUnavailable() {},
  })
  t.after(async () => {
    controller.abort()
    await collector.done
    await sim.close()
  })
  async function next(act: () => void) {
    const count = seen.length
    act()
    for (let i = 0; i < 500 && seen.length === count; i++) await delay(10)
    assert.ok(seen.length > count, 'no observation')
    return seen.at(-1)!
  }
  const publish = (value: unknown) => () =>
    sim.control.publish(
      sim.reportTopic.replace('/info/', '/print/'),
      value as object,
    )
  for (let i = 0; i < 500 && !sim.control.subscriptions.size; i++)
    await delay(10)
  await delay(50)

  await next(() => sim.setPrintProgress(25))
  let printer = await next(publish(print('paused', runout, {})))
  assert.equal(printer.state, 'paused')
  assert.equal(printer.statusMessage, paused)
  assert.equal(anycubicPrinterDetail(printer, 1)!.detail.print!.message, paused)
  printer = await next(() => sim.setPrintProgress(30))
  assert.equal(printer.statusMessage, undefined)

  printer = await next(publish(print('stoped', fault)))
  assert.equal(printer.state, 'error')
  assert.equal(printer.statusMessage, ended)
  assert.equal(printer.lastJob?.outcome, 'failed')
  printer = await next(
    publish({ type: 'info', data: { state: 'free', project: null } }),
  )
  assert.equal(printer.state, 'idle')
  assert.equal(printer.statusMessage, ended)

  printer = await next(() => sim.setPrintProgress(5))
  assert.equal(printer.statusMessage, undefined)
  printer = await next(
    publish(print('stoped', { action: 'stop', code: 10601 })),
  )
  assert.equal(printer.statusMessage, undefined)
  assert.equal(printer.lastJob?.outcome, 'cancelled')
})

test('Kobra X reads 10601 as a user stop and keeps fault reasons', () => {
  const status = createKobraXStatus('fixture', '127.0.0.1')
  const apply = (value: Record<string, unknown>) =>
    status.report('print', { msgid: 'synthetic', ...value })
  const stop = {
    msgid: 'synthetic',
    ...print('stoped', { action: 'stop', code: 10601 }),
  }
  assert.equal(reportRefusal(parseKobraXReport('print', stop)!), null)
  assert.equal(
    reportRefusal(parseKobraXReport('print', { ...stop, action: 'pause' })!),
    10601,
  )

  apply(print('preheating', {}, {}))
  assert.equal(status.snapshot().state, 'printing')
  apply(print('paused', runout, {}))
  assert.equal(status.snapshot().statusMessage, paused)
  apply(print('printing', {}, {}))
  assert.equal(status.snapshot().statusMessage, undefined)
  apply(stop)
  assert.equal(status.snapshot().state, 'idle')
  assert.equal(status.snapshot().lastJob?.outcome, 'cancelled')

  apply(print('printing', {}, {}))
  apply(print('stoped', fault, {}))
  assert.equal(status.snapshot().state, 'error')
  assert.equal(status.snapshot().statusMessage, ended)
  status.report('info', { data: { state: 'free', project: null } })
  assert.equal(status.snapshot().statusMessage, ended)
  status.report('info', { data: { state: 'busy' } })
  assert.equal(status.snapshot().statusMessage, undefined)
})

test('the Kobra 3 reported FLV endpoint fits the passive camera source', () => {
  // `urls.rtspUrl` of `K3_INFO` is `http://<printer>:18088/flv`. No socket opens.
  const status = createKobraXStatus('fixture', '192.168.1.20')
  status.report('info', {
    data: {
      state: 'free',
      urls: { rtspUrl: 'http://192.168.1.20:18088/flv' },
    },
  })
  const url = new URL(status.cameraUrl()!)
  assert.deepEqual(
    selectAnycubicCamera({
      kind: 'kobra-x-flv',
      host: url.hostname,
      port: Number(url.port),
      path: url.pathname,
    }),
    { kind: 'flv', host: '192.168.1.20', port: 18088 },
  )
})
