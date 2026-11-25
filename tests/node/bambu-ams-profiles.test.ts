/**
 * AMS HT and expanded AMS addressing, partial updates, clears and machine
 * profiles. Report data is reference-derived, never captured from a printer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyBambuAmsReport,
  bambuTrayAddress,
  BAMBU_MAX_MATERIALS,
} from '../../packages/connector/src/bambu/ams.ts'
import { buildBambuFilamentCommand } from '../../packages/connector/src/bambu/filament.ts'
import { decodeBambuReport } from '../../packages/connector/src/bambu/report.ts'
import { parseBambuBinding } from '../../packages/connector/src/bambu/configuration.ts'
import {
  createBambuRuntimeSubscription,
  type BambuRuntimeEvent,
} from '../../packages/connector/src/bambu/runtime.ts'
import {
  mergeBambuMachineProfile,
  parseBambuMachineProfile,
} from '../../packages/connector/src/machine-profile/bambu.ts'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import {
  dualNozzleReport,
  expandedAms,
} from '../fixtures/bambu-reference-derived.ts'

const materialsOf = (print: object) => {
  const decoded = decodeBambuReport({ print })
  assert.ok(decoded.kind === 'observation')
  return decoded.materials ?? []
}
const slots = (items: { slot: string }[]) => items.map((item) => item.slot)

test('addresses standard trays and AMS HT units', () => {
  assert.deepEqual(bambuTrayAddress(0), { amsId: 0, slotId: 0 })
  assert.deepEqual(bambuTrayAddress(15), { amsId: 3, slotId: 3 })
  assert.deepEqual(bambuTrayAddress(135), { amsId: 135, slotId: 0 })
  for (const index of [-1, 16, 127, 136, 254, 255, 1.5])
    assert.equal(bambuTrayAddress(index), undefined)
  assert.equal(buildBambuFilamentCommand(129, 220).print.ams_id, 129)
  assert.equal('ams_id' in buildBambuFilamentCommand(255, 220).print, false)
  for (const target of [16, 127, 136, 254])
    assert.throws(() => buildBambuFilamentCommand(target, 220))
  assert.throws(() => buildBambuFilamentCommand(255, 220, '0', 4))
  assert.throws(() => buildBambuFilamentCommand(1, 220, '0', 0))
})

test('decodes expanded AMS, AMS HT and two external spools', () => {
  const materials = materialsOf({
    ...dualNozzleReport(),
    ams: expandedAms(),
  })
  assert.deepEqual(slots(materials), [
    'ams:0:0',
    'ams:0:1',
    'ams:0:2',
    'ams:0:3',
    'ams:1:0',
    'ams:1:1',
    'ams:128:0',
    'external',
    'external:254',
  ])
  assert.equal(materials[6]!.materialType, 'PA')
  assert.deepEqual(materials[2], { slot: 'ams:0:2', active: false })
})

test('marks the active slot from tray_now and from each extruder', () => {
  const active = (print: object) =>
    slots(materialsOf(print).filter((item) => item.active))
  assert.deepEqual(active({ ams: { ...expandedAms(), tray_now: '128' } }), [
    'ams:128:0',
  ])
  assert.deepEqual(active({ ams: { ...expandedAms(), tray_now: '5' } }), [
    'ams:1:1',
  ])
  const report = dualNozzleReport()
  report.device.extruder.info[0]!.snow = (1 << 8) | 0
  report.device.extruder.info[1]!.snow = 128 << 8
  assert.deepEqual(active(report), ['ams:1:0', 'ams:128:0'])
  report.device.extruder.info[0]!.snow = 255 << 8
  report.device.extruder.info[1]!.snow = 0xffff
  assert.deepEqual(active(report), ['external'])
})

test('partial reports update; shorter lists and exist bits clear', () => {
  let state = applyBambuAmsReport(undefined, { ams: expandedAms() })!
  assert.equal(state.length, 7)
  // Only the active slot moves: every slot is retained.
  state = applyBambuAmsReport(state, { ams: { tray_now: '128' } })!
  assert.equal(state.length, 7)
  assert.deepEqual(slots(state.filter((item) => item.active)), ['ams:128:0'])
  // A report without slot data changes nothing.
  assert.equal(applyBambuAmsReport(state, { nozzle_temper: 200 }), undefined)
  // A cleared exist bit (AMS HT 128 is bit 16) empties that slot.
  state = applyBambuAmsReport(state, { ams: { tray_exist_bits: '13' } })!
  assert.deepEqual(state.at(-1), { slot: 'ams:128:0', active: true })
  assert.equal(state[0]!.materialType, 'PLA')
  // A tray reported with only its id loses its filament.
  state = applyBambuAmsReport(state, {
    ams: { ams: [{ id: '0', tray: [{ id: '0' }] }, { id: '1' }] },
  })!
  // Unit 0: its tray list is complete. Unit 1 has no list: retained.
  // Unit 128 left the unit list: removed.
  assert.deepEqual(slots(state), ['ams:0:0', 'ams:1:0', 'ams:1:1'])
  assert.equal(state[0]!.materialType, undefined)
  assert.equal(state[1]!.materialType, 'ABS')
  // A cleared unit bit removes the unit.
  state = applyBambuAmsReport(state, { ams: { ams_exist_bits: '1' } })!
  assert.deepEqual(slots(state), ['ams:0:0'])
  assert.deepEqual(applyBambuAmsReport(state, { ams: { ams: [] } }), [])
})

test('stays within the protocol bound and keeps external spools', () => {
  const unit = (id: number, trays: number) => ({
    id: String(id),
    tray: Array.from({ length: trays }, (_, tray) => ({ id: String(tray) })),
  })
  const materials = materialsOf({
    ams: {
      ams: [
        ...[0, 1, 2, 3].map((id) => unit(id, 4)),
        unit(128, 1),
        unit(129, 1),
      ],
    },
    vir_slot: [{ id: '255' }, { id: '254' }],
  })
  assert.equal(materials.length, BAMBU_MAX_MATERIALS)
  assert.deepEqual(slots(materials.slice(-2)), ['external', 'external:254'])
})

test('runtime publishes clears and the dual-nozzle profile', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bambu-ams-profiles-'))
  const credentialFile = join(directory, 'credential.json')
  writeFileSync(credentialFile, JSON.stringify({ accessCode: 'synthetic' }))
  chmodSync(credentialFile, 0o600)
  const events: BambuRuntimeEvent[] = []
  type Transport = NonNullable<
    Parameters<typeof createBambuRuntimeSubscription>[0]['transport']
  >
  let peer: Parameters<Transport>[0] | undefined
  let finish = () => {}
  const done = new Promise<void>((resolve) => (finish = resolve))
  const subscription = createBambuRuntimeSubscription({
    binding: parseBambuBinding({
      printerKey: 'test',
      serial: 'SYNTHETIC',
      host: '127.0.0.1',
      credentialFile,
      pinSha256: 'a'.repeat(64),
      allowedEndpoints: [{ host: '127.0.0.1' }],
    }),
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    transport: (options) => {
      peer = options
      options.signal.addEventListener('abort', () => finish(), { once: true })
      return { done, close: async () => finish() }
    },
  })
  t.after(async () => {
    subscription.close()
    await subscription.done
    rmSync(directory, { recursive: true, force: true })
  })
  const report = (print: object) => {
    peer!.onReport(Buffer.from(JSON.stringify({ print })))
    const event = events.at(-1)!
    assert.ok(event.kind === 'snapshot', JSON.stringify(event))
    return event.printer
  }
  peer!.onConnection('connected')
  let printer = report({
    gcode_state: 'IDLE',
    mc_percent: 0,
    ...dualNozzleReport(),
  })
  assert.equal(printer.materials?.length, 9)
  assert.equal(printer.machine?.toolCount, 2)
  // Partial: neither the profile nor the slots are lost.
  printer = report({ nozzle_diameter: '0.4', ams: { tray_now: '0' } })
  assert.equal(printer.materials?.length, 9)
  assert.deepEqual(printer.machine?.nozzleDiametersMm, [0.4, 0.6])
  assert.equal(printer.machine?.materialUnits?.length, 3)
  // The AMS HT is unplugged.
  const ams = expandedAms()
  printer = report({ ams: { ...ams, ams: ams.ams.slice(0, 2) } })
  assert.equal(
    printer.materials?.some((item) => item.slot === 'ams:128:0'),
    false,
  )
  assert.deepEqual(
    printer.machine?.materialUnits?.map((unit) => unit.id),
    [0, 1],
  )
  printer = report({ ams: { ams: [] } })
  assert.deepEqual(slots(printer.materials!), ['external', 'external:254'])
  assert.equal(printer.machine?.materialUnits, undefined)
})

test('machine profile covers dual nozzles and filament units', () => {
  assert.deepEqual(parseBambuMachineProfile({ print: dualNozzleReport() }), {
    toolCount: 2,
    nozzleDiametersMm: [0.4, 0.6],
    materialUnits: [
      { id: 0, kind: 'ams', slots: 4, tool: 0 },
      { id: 1, kind: 'ams-2-pro', slots: 4, tool: 1 },
      { id: 128, kind: 'ams-ht', slots: 1, tool: 1 },
    ],
  })
  // Two extruders without per-nozzle data: diameters stay unknown.
  const two = { print: { device: { extruder: { state: 2 } } } }
  const single = parseBambuMachineProfile({
    print: { nozzle_diameter: '0.4' },
  })
  assert.deepEqual(mergeBambuMachineProfile(single, two), { toolCount: 2 })
  // A rack nozzle is not a mounted tool.
  const rack = dualNozzleReport()
  rack.device.nozzle.info.push({ id: 0x10, diameter: 0.8, type: 'HS01' })
  assert.deepEqual(
    parseBambuMachineProfile({ print: rack })?.nozzleDiametersMm,
    [0.4, 0.6],
  )
  // Units that do not state their type are not described.
  assert.equal(
    parseBambuMachineProfile({
      print: { ams: { ams: [{ id: '0', tray: [] }] } },
    }),
    undefined,
  )
})

test('simulator reports expanded AMS that the connector decodes', async (t) => {
  const sim = await startBambuSimulator({
    initialState: 'IDLE',
    initialReport: { ams: expandedAms() },
  })
  const directory = mkdtempSync(join(tmpdir(), 'bambu-ams-sim-'))
  const credentialFile = join(directory, 'credential.json')
  const caFile = join(directory, 'ca.pem')
  writeFileSync(credentialFile, JSON.stringify({ accessCode: 'secret' }), {
    mode: 0o600,
  })
  writeFileSync(caFile, sim.syntheticTrust)
  const events: BambuRuntimeEvent[] = []
  const subscription = createBambuRuntimeSubscription({
    binding: parseBambuBinding({
      printerKey: 'test',
      serial: 'SYNTHETIC',
      host: sim.host,
      port: sim.port,
      credentialFile,
      caFile,
      allowedEndpoints: [{ host: sim.host, port: sim.port }],
    }),
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  })
  t.after(async () => {
    subscription.close()
    await subscription.done
    await sim.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const deadline = performance.now() + 5000
  const found = () =>
    events.findLast(
      (event) => event.kind === 'snapshot' && event.printer.materials,
    )
  while (!found() && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  const event = found()
  assert.ok(event?.kind === 'snapshot')
  assert.equal(event.printer.materials?.length, 7)
  assert.equal(event.printer.machine?.materialUnits?.length, 3)
})
