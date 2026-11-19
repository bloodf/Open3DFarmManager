import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  startMoonrakerMock,
  type MoonrakerMockInstance,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  MachineProfile,
  PrinterState,
  TelemetryBatch,
  parseBoundedJson,
} from '../../packages/farm-protocol/src/index.ts'
import {
  parseMoonrakerMachineProfile,
  readMoonrakerMachineProfile,
} from '../../packages/connector/src/machine-profile/moonraker.ts'
import { fetchMoonrakerConfigfile } from '../../packages/connector/src/machine-profile/moonraker-fetch.ts'
import { createMachineProfileGate } from '../../packages/connector/src/machine-profile/on-change.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { parseLocalCollectorConfig } from '../../packages/connector/src/config/local.ts'

const cartesian = {
  printer: { kinematics: 'cartesian', max_velocity: 300 },
  stepper_x: { position_min: 0, position_max: 220, position_endstop: 0 },
  stepper_y: { position_max: 220 },
  stepper_z: { position_min: -2, position_max: 250 },
  extruder: { nozzle_diameter: 0.4, max_temp: 300, min_temp: 0 },
  heater_bed: { max_temp: 110 },
}

const mocks: MoonrakerMockInstance[] = []
const directories: string[] = []
afterEach(async () => {
  for (const mock of mocks.splice(0)) await mock.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
async function start(options: Parameters<typeof startMoonrakerMock>[0]) {
  const mock = await startMoonrakerMock(options)
  mocks.push(mock)
  return mock
}
const limits = {
  maxMessageBytes: 256 * 1024,
  connectTimeoutMs: 5000,
  requestTimeoutMs: 5000,
  staleAfterMs: 30_000,
  reconnectMinMs: 1000,
  reconnectMaxMs: 30_000,
}
async function readFromMock(mock: MoonrakerMockInstance) {
  return readMoonrakerMachineProfile({
    request: () =>
      fetchMoonrakerConfigfile({
        origin: mock.origin,
        limits,
        signal: new AbortController().signal,
      }),
  })
}

describe('Moonraker machine profile', () => {
  it('maps a single-extruder cartesian configfile', () => {
    expect(parseMoonrakerMachineProfile(cartesian)).toEqual({
      toolCount: 1,
      nozzleDiametersMm: [0.4],
      bedSizeMm: { x: 220, y: 220, z: 250 },
      maxHotendCelsius: 300,
      maxBedCelsius: 110,
      kinematics: 'cartesian',
    })
  })

  it('reports each tool in order and the limit every tool can reach', () => {
    expect(
      parseMoonrakerMachineProfile({
        ...cartesian,
        extruder1: { nozzle_diameter: '0.6', max_temp: 280 },
        extruder2: { nozzle_diameter: 0.8, max_temp: 300 },
      }),
    ).toMatchObject({
      toolCount: 3,
      nozzleDiametersMm: [0.4, 0.6, 0.8],
      maxHotendCelsius: 280,
    })
  })

  it('omits unknown values instead of guessing', () => {
    expect(parseMoonrakerMachineProfile({})).toBeUndefined()
    expect(parseMoonrakerMachineProfile(null)).toBeUndefined()
    expect(parseMoonrakerMachineProfile([cartesian])).toBeUndefined()
    // No nozzle or max_temp: only the tool count is known.
    expect(parseMoonrakerMachineProfile({ extruder: { min_temp: 0 } })).toEqual(
      { toolCount: 1 },
    )
    // One tool without a diameter: no per-tool array, other facts remain.
    const partial = parseMoonrakerMachineProfile({
      ...cartesian,
      extruder1: { max_temp: 300 },
    })
    expect(partial).not.toHaveProperty('nozzleDiametersMm')
    expect(partial).toMatchObject({ toolCount: 2, maxHotendCelsius: 300 })
    // A bed needs all three axes.
    const noZ = parseMoonrakerMachineProfile({
      ...cartesian,
      stepper_z: undefined,
    })
    expect(noZ).not.toHaveProperty('bedSizeMm')
    // Delta has no stepper_x/y/z.
    expect(
      parseMoonrakerMachineProfile({
        printer: { kinematics: 'delta' },
        stepper_a: { position_max: 300 },
      }),
    ).toEqual({ kinematics: 'delta' })
  })

  it('rejects hostile and out-of-range values', () => {
    expect(
      parseMoonrakerMachineProfile({
        printer: { kinematics: 'Cartesian; DROP' },
        stepper_x: { position_max: -5 },
        stepper_y: { position_max: 'NaN' },
        stepper_z: { position_max: 1e9 },
        extruder: { nozzle_diameter: 0, max_temp: 99999 },
        heater_bed: { max_temp: '1e3' },
      }),
    ).toEqual({ toolCount: 1 })
    const many = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        index ? `extruder${index}` : 'extruder',
        { nozzle_diameter: 0.4, max_temp: 250 },
      ]),
    )
    expect(parseMoonrakerMachineProfile(many)).toBeUndefined()
  })

  it('reads the profile from the Moonraker mock over loopback', async () => {
    const mock = await start({ configfileSettings: cartesian })
    expect(await readFromMock(mock)).toEqual(
      parseMoonrakerMachineProfile(cartesian),
    )
  })

  it('reports nothing when the mock has no configfile', async () => {
    const mock = await start({})
    expect(await readFromMock(mock)).toBeUndefined()
  })

  it('schema rejects empty, mismatched and unknown fields', () => {
    expect(MachineProfile.safeParse({}).success).toBe(false)
    expect(
      MachineProfile.safeParse({ toolCount: 2, nozzleDiametersMm: [0.4] })
        .success,
    ).toBe(false)
    expect(MachineProfile.safeParse({ guess: 1 }).success).toBe(false)
    expect(MachineProfile.safeParse({ maxBedCelsius: 0 }).success).toBe(false)
  })

  it('sends the block only when it changes', () => {
    const gate = createMachineProfileGate()
    const state = (machine?: MachineProfile): PrinterState => ({
      printerKey: 'p',
      state: 'offline',
      observedAt: 1,
      ...(machine ? { machine } : {}),
    })
    const a = { toolCount: 1 }
    expect(gate.apply(state(a)).machine).toEqual(a)
    expect(gate.apply(state(a))).not.toHaveProperty('machine')
    expect(gate.apply(state())).not.toHaveProperty('machine')
    expect(gate.apply(state({ toolCount: 2 })).machine).toEqual({
      toolCount: 2,
    })
    gate.forget('p')
    expect(gate.apply(state({ toolCount: 2 })).machine).toEqual({
      toolCount: 2,
    })
  })

  it('never reaches the size-capped live snapshot', () => {
    const agentId = randomUUID()
    const refs = Array.from({ length: 16 }, (_, index) => ({
      assignmentId: randomUUID(),
      agentId,
      printerKey: `printer-${index}`,
    }))
    const sizes: number[] = []
    for (const machine of [
      undefined,
      parseMoonrakerMachineProfile(cartesian),
    ]) {
      const source = createFarmSnapshotSource({
        assignmentRefs: refs,
        nowMono: () => 1000,
      })
      for (const ref of refs)
        source.observe({
          printerKey: ref.printerKey,
          epoch: 1,
          printer: {
            printerKey: ref.printerKey,
            state: 'idle',
            progress: 0,
            observedAt: 1,
            ...(machine ? { machine } : {}),
          },
          receivedAtMonoMs: 1000,
          fieldObservedAtMonoMs: {
            creality: { state: 1000, progress: 1000 },
          },
        })
      let frame: string | undefined
      source.open({
        binding: { agent_id: agentId } as never,
        assignmentRefs: refs,
        deadlineMonoMs: 2000,
        signal: new AbortController().signal,
        onComplete: (value) => {
          frame = JSON.stringify({
            t: 'snapshot',
            seq: 1024,
            printers: value.printers,
          })
        },
        onUnavailable: () => {},
      })
      expect(frame).toBeDefined()
      expect(frame).not.toContain('machine')
      sizes.push(Buffer.byteLength(frame!))
    }
    expect(sizes[0]).toBe(sizes[1])
  })

  it('keeps 100 printer-state events within the telemetry batch limits', () => {
    const machine = parseMoonrakerMachineProfile(cartesian)!
    const batch = Array.from({ length: 100 }, (_, index) => ({
      eventId: randomUUID(),
      kind: 'printer-state' as const,
      queuedAt: 1000,
      state: {
        printerKey: `printer-${index}`,
        state: 'offline' as const,
        observedAt: 1000,
        machine,
      },
    }))
    const body = JSON.stringify(batch)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(65536)
    // The same bounds the HTTP sender and the server enforce.
    expect(() =>
      parseBoundedJson(body, {
        maxBytes: 65536,
        maxDepth: 7,
        maxValues: 2000,
        maxStringChars: 128,
      }),
    ).not.toThrow()
    expect(TelemetryBatch.safeParse(batch).success).toBe(true)
  })

  it('queues the machine block once, from the mock, through the collector', async () => {
    const mock = await start({ configfileSettings: cartesian })
    const directory = mkdtempSync(join(tmpdir(), 'machine-profile-'))
    directories.push(directory)
    const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
    const controller = new AbortController()
    const done = collectIntoQueue({
      config: parseLocalCollectorConfig({
        version: 1,
        allowedOrigins: [mock.origin],
        printers: [{ printerKey: 'fixture', origin: mock.origin }],
      }),
      queue,
      signal: controller.signal,
      onDiagnostic() {},
      // The agent runtime always observes; the profile read is tied to it.
      onRawObservation() {},
    })
    try {
      const queued = () =>
        queue
          .batch(Date.now(), 100)
          .records.flatMap((record) =>
            record.kind === 'printer-state' ? [record.state] : [],
          )
      const deadline = Date.now() + 8000
      let progress = 0
      while (
        !queued().some((state) => state.machine) &&
        Date.now() < deadline
      ) {
        mock.control.update({ progress: (progress += 0.01) })
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      // Further samples must not repeat the unchanged block.
      for (let index = 0; index < 5; index++) {
        mock.control.update({ progress: (progress += 0.01) })
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const states = queued()
      const withMachine = states.filter((state) => state.machine)
      expect(withMachine).toHaveLength(1)
      expect(withMachine[0]!.machine).toEqual(
        parseMoonrakerMachineProfile(cartesian),
      )
      expect(states.length).toBeGreaterThan(1)
    } finally {
      controller.abort()
      await done
      queue.close()
    }
  }, 20_000)
})
