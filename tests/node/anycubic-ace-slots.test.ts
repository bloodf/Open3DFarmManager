import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  anycubicBoxMaterials,
  anycubicExternalMaterial,
  mergeAnycubicMaterials,
} from '../../packages/connector/src/anycubic/ace.ts'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'
import { connectKobraX } from '../../packages/connector/src/kobra-x/index.ts'
import { createKobraXStatus } from '../../packages/connector/src/kobra-x/status.ts'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import { activeSpoolsFromMaterials } from '../../packages/farm-protocol/src/status.ts'
import {
  installNetworkGuard,
  startKobraXMock,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'
import extfilbox from '../fixtures/anycubic/ace/extfilbox.json' with { type: 'json' }
import oneAce from '../fixtures/anycubic/ace/one-ace.json' with { type: 'json' }
import twoAce from '../fixtures/anycubic/ace/two-ace-holder.json' with { type: 'json' }

const ONE_ACE = [
  {
    slot: '0:0',
    materialType: 'PLA',
    colorHex: 'E10600FF',
    active: false,
  },
  {
    slot: '0:1',
    materialType: 'PETG',
    colorHex: '43523BFF',
    remainingPercent: 95,
    rfid: { tag: '999000001', sku: 'PLACEHOLDER-SKU-0001' },
    active: true,
  },
  { slot: '0:2', remainingPercent: 0, active: false },
  { slot: '0:3', materialType: 'TPU', colorHex: '0AC80AFF', active: false },
]

const decoded = (report: unknown) => {
  const result = decodeAnycubicReport(Buffer.from(JSON.stringify(report)))
  return result.kind === 'observation'
    ? (result as { materials?: PrinterState['materials'] }).materials
    : undefined
}

function kobraX() {
  const status = createKobraXStatus('fixture', '127.0.0.1')
  return {
    status,
    report(message: { type: string }) {
      status.report(message.type, message)
      return status.snapshot().materials
    },
  }
}

const boxReport = (boxes: unknown[], state = 'done') => ({
  type: 'multiColorBox',
  action: 'getInfo',
  state,
  data: { multi_color_box: boxes },
})

test('one ACE: both report paths map the same four slots', () => {
  assert.deepEqual(decoded(oneAce), ONE_ACE)
  assert.deepEqual(kobraX().report(oneAce), ONE_ACE)
})

test('two ACE units and the spool holder keep their own box ids', () => {
  const materials = kobraX().report(twoAce)!
  // The holder's fourth inlet carries the ACE, so `-1:3` is not a spool.
  assert.deepEqual(
    materials.map((material) => material.slot),
    ['-1:0', '-1:1', '-1:2', '0:0', '0:1', '0:2', '0:3'].concat([
      '1:0',
      '1:1',
      '1:2',
      '1:3',
    ]),
  )
  assert.deepEqual(
    materials.filter((material) => material.active).map((m) => m.slot),
    ['1:2'],
  )
  assert.deepEqual(decoded(twoAce), materials)
})

test('empty slots carry no material, colour, identity or invented amount', () => {
  const materials = kobraX().report(twoAce)!
  const bySlot = Object.fromEntries(materials.map((m) => [m.slot, m]))
  assert.deepEqual(bySlot['-1:1'], {
    slot: '-1:1',
    remainingPercent: 0,
    active: false,
  })
  assert.deepEqual(bySlot['-1:2'], { slot: '-1:2', active: false })
  assert.deepEqual(
    anycubicBoxMaterials([
      {
        id: 0,
        slots: [
          {
            index: 0,
            status: 0,
            type: 'PLA',
            color: [1, 2, 3],
            sku: 'PLACEHOLDER-SKU-0001',
            consumables_percent: 50,
          },
        ],
      },
    ]),
    [{ slot: '0:0' }],
  )
})

test('an unknown remaining amount stays unknown, a reported 0 stays 0', () => {
  const remaining = (consumables_percent: unknown) =>
    anycubicBoxMaterials([
      { id: 0, slots: [{ index: 0, type: 'PLA', consumables_percent }] },
    ])![0]!.remainingPercent
  for (const unknown of [undefined, null, '', '50', -1, 100, 101, NaN])
    assert.equal(remaining(unknown), undefined, String(unknown))
  assert.equal(remaining(0), 0)
  assert.equal(remaining(99.5), 99.5)
})

test('RFID identity is reported only when the slot carries it', () => {
  const materials = kobraX().report(twoAce)!
  assert.deepEqual(
    Object.fromEntries(
      materials.flatMap((m) => (m.rfid ? [[m.slot, m.rfid]] : [])),
    ),
    {
      '0:1': { tag: '999000001', sku: 'PLACEHOLDER-SKU-0001' },
      '1:0': { sku: 'PLACEHOLDER-SKU-0002' },
      '1:2': { tag: '999000002' },
    },
  )
  PrinterState.shape.materials.parse(materials)
  // An observation only: nothing binds it to a Spoolman spool.
  const spools = activeSpoolsFromMaterials(materials)!
  assert.ok(spools.every((spool) => spool.spoolId === undefined))
  assert.ok(!JSON.stringify(spools).includes('PLACEHOLDER'))
})

test('the external spool joins the box slots without replacing them', () => {
  const printer = kobraX()
  printer.report(oneAce)
  const materials = printer.report(extfilbox)!
  assert.deepEqual(materials, [
    ...ONE_ACE,
    { slot: 'external', materialType: 'PLA', colorHex: 'FF0000FF' },
  ])
  assert.equal(printer.report(oneAce)!.at(-1)!.slot, 'external')
  // Its `type` and `status` are not read as printer telemetry.
  assert.deepEqual(
    decodeAnycubicReport(Buffer.from(JSON.stringify(extfilbox))),
    { kind: 'observation', materials: [materials.at(-1)] },
  )
  assert.equal(anycubicExternalMaterial({}), undefined)
  assert.deepEqual(anycubicExternalMaterial({ status: 0, type: '' }), {
    slot: 'external',
  })
})

test('partial, failed and empty reports', () => {
  const printer = kobraX()
  printer.report(twoAce)
  const before = printer.report(extfilbox)!
  // Drying state only: no slots, so nothing changes.
  assert.deepEqual(
    printer.report(boxReport([{ id: 0, drying_status: { status: 1 } }])),
    before,
  )
  assert.deepEqual(printer.report(boxReport([], 'failed')), before)
  const edited = printer.report(
    boxReport([{ id: 1, slots: [{ index: 3, status: 5, type: 'PETG' }] }]),
  )!
  assert.equal(edited.length, before.length)
  assert.deepEqual(
    edited.find((m) => m.slot === '1:3'),
    { slot: '1:3', materialType: 'PETG', active: false },
  )
  assert.deepEqual(
    printer.report(boxReport([]))!.map((m) => m.slot),
    ['external'],
  )
  printer.status.disconnect()
  assert.equal(printer.status.snapshot().materials, undefined)
})

test('malformed boxes are skipped and the list stays within the protocol', () => {
  assert.equal(anycubicBoxMaterials({}), undefined)
  assert.equal(anycubicBoxMaterials([{ slots: [{ index: 0 }] }]), undefined)
  assert.deepEqual(
    anycubicBoxMaterials([
      { id: 0, slots: [{ index: 9 }, { index: 2, type: 'PLA' }] },
    ]),
    [{ slot: '0:2', materialType: 'PLA' }],
  )
  const full = [-1, 0, 1, 2, 3].map((id) => ({
    id,
    slots: [0, 1, 2, 3].map((index) => ({ index, type: 'PLA' })),
  }))
  const merged = mergeAnycubicMaterials(
    [{ slot: 'external' }],
    anycubicBoxMaterials(full)!,
  )
  assert.equal(merged.length, 17)
  assert.equal(merged.at(-1)!.slot, 'external')
  PrinterState.shape.materials.parse(merged)
})

test('the LAN collector merges box and external reports', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ace-slots-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const passwordFile = join(directory, 'password.json')
  writeFileSync(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const controller = new AbortController()
  let publish: (payload: Buffer) => void = () => {}
  let latest: PrinterState | undefined
  createAnycubicCollection({
    binding: {
      printerKey: 'fixture',
      host: '127.0.0.1',
      port: 9883,
      modelId: '20024',
      deviceId: 'SYNTHETIC',
      username: 'user',
      passwordFile,
    },
    signal: controller.signal,
    transport: (options) => {
      publish = options.onReport
      return { done: Promise.resolve(), close: async () => {} }
    },
    onObservation: (value) => (latest = value.printer),
    onUnavailable() {},
  })
  t.after(() => controller.abort())
  const send = (value: unknown) => publish(Buffer.from(JSON.stringify(value)))
  send({ data: { state: 'free', progress: 0 } })
  send(oneAce)
  send(extfilbox)
  assert.deepEqual(
    latest?.materials?.map((m) => m.slot),
    ['0:0', '0:1', '0:2', '0:3', 'external'],
  )
})

test('Kobra X simulator: holder, external spool and a second ACE unit', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const mock = await startKobraXMock({
    spoolHolder: true,
    externalSpool: extfilbox.data,
    reportIntervalMs: 0,
    ssdp: false,
    camera: false,
  })
  t.after(() => mock.close())
  const adapter = await connectKobraX({
    address: '127.0.0.1',
    printerKey: 'fixture',
    httpPort: mock.httpPort,
    mqttPort: mock.mqttPort,
    pinSha256: mock.tls.serverFingerprintSha256!,
    clientIdentity: { cert: mock.tls.clientCert, key: mock.tls.clientKey },
  })
  t.after(() => adapter.close())
  const materials = () => adapter.snapshot().materials ?? []
  async function until(count: number) {
    for (let i = 0; i < 100 && materials().length !== count; i++)
      await delay(20)
    assert.equal(materials().length, count, JSON.stringify(materials()))
  }
  await until(8)
  assert.deepEqual(
    materials().find((m) => m.slot === '0:2'),
    {
      slot: '0:2',
      materialType: 'PETG',
      colorHex: 'FF0000FF',
      remainingPercent: 70,
      active: false,
    },
  )
  // The mock's first ACE slot answers 100: no reading.
  assert.ok(!('remainingPercent' in materials().find((m) => m.slot === '0:0')!))
  mock.control.publishTypedReport('multiColorBox', 'getInfo', {
    multi_color_box: [
      { id: 1, loaded_slot: -1, slots: [{ index: 0, status: 0, type: '' }] },
    ],
  })
  await until(9)
  assert.equal(materials().at(-1)!.slot, 'external')
})
