import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'
import { decodeCrealityStatus } from '../../packages/connector/src/creality/index.ts'
import { reportedModelProfile } from '../../packages/connector/src/runtime/machine-profile.ts'
import { parseBambuMachineProfile } from '../../packages/connector/src/machine-profile/bambu.ts'
import {
  createBambuRuntimeSubscription,
  type BambuRuntimeEvent,
} from '../../packages/connector/src/bambu/runtime.ts'
import { parseBambuBinding } from '../../packages/connector/src/bambu/configuration.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { parseLocalCollectorConfig } from '../../packages/connector/src/config/local.ts'

const directories: string[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'machine-profile-bambu-'))
  directories.push(directory)
  return directory
}

describe('Bambu machine profile', () => {
  it('reads the nozzle diameter from a print report', () => {
    expect(
      parseBambuMachineProfile({ print: { nozzle_diameter: '0.4' } }),
    ).toEqual({ nozzleDiametersMm: [0.4] })
    expect(
      parseBambuMachineProfile({ print: { nozzle_diameter: 0.6 } }),
    ).toEqual({ nozzleDiametersMm: [0.6] })
  })

  it('omits everything the report does not carry', () => {
    for (const report of [
      undefined,
      null,
      'print',
      {},
      { print: null },
      { print: {} },
      { print: { gcode_state: 'IDLE', nozzle_temper: 210 } },
      { print: { nozzle_diameter: null } },
      { print: { nozzle_diameter: '' } },
      { print: { nozzle_diameter: 'abc' } },
      { print: { nozzle_diameter: '0' } },
      { print: { nozzle_diameter: -0.4 } },
      { print: { nozzle_diameter: '99999' } },
      { print: { nozzle_diameter: Infinity } },
      { print: { nozzle_diameter: [0.4] } },
      { info: { command: 'get_version', module: [] } },
    ])
      expect(parseBambuMachineProfile(report)).toBeUndefined()
    // No model table: bed size, tool count and limits are never inferred.
    const known = parseBambuMachineProfile({
      print: { nozzle_diameter: '0.4' },
    })
    expect(Object.keys(known ?? {})).toEqual(['nozzleDiametersMm'])
  })

  it('carries the profile on runtime snapshots and drops it on reconnect', () => {
    const directory = temporary()
    const credentialFile = join(directory, 'credential.json')
    writeFileSync(credentialFile, JSON.stringify({ accessCode: 'synthetic' }))
    chmodSync(credentialFile, 0o600)
    const events: BambuRuntimeEvent[] = []
    let peer:
      | Parameters<
          NonNullable<
            Parameters<typeof createBambuRuntimeSubscription>[0]['transport']
          >
        >[0]
      | undefined
    let finish = () => {}
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const sub = createBambuRuntimeSubscription({
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
        options.signal.addEventListener('abort', finish, { once: true })
        return { done, close: async () => finish() }
      },
    })
    closers.push(async () => {
      sub.close()
      await sub.done
    })
    const report = (print: object) =>
      peer?.onReport(Buffer.from(JSON.stringify({ print })))
    const last = () => events.at(-1)
    peer?.onConnection('connected')
    report({ gcode_state: 'IDLE', mc_percent: 0 })
    expect(last()).toMatchObject({ kind: 'snapshot' })
    expect(JSON.stringify(last())).not.toContain('machine')
    report({ nozzle_diameter: '0.4' })
    expect(last()).toMatchObject({
      printer: { machine: { nozzleDiametersMm: [0.4] } },
    })
    peer?.onConnection('disconnected')
    peer?.onConnection('connected')
    report({ gcode_state: 'IDLE', mc_percent: 0 })
    expect(JSON.stringify(last())).not.toContain('machine')
  })

  it('queues the profile once from the Bambu simulator through the collector', async () => {
    const directory = temporary()
    const sim = await startBambuSimulator({
      initialState: 'IDLE',
      nozzleDiameter: '0.4',
    })
    closers.push(() => sim.close())
    const credentialFile = join(directory, 'credentials.json')
    const caFile = join(directory, 'ca.pem')
    writeFileSync(credentialFile, JSON.stringify({ accessCode: 'secret' }), {
      mode: 0o600,
    })
    writeFileSync(caFile, sim.syntheticTrust)
    const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
    const controller = new AbortController()
    const done = collectIntoQueue({
      config: parseLocalCollectorConfig({
        version: 3,
        allowedOrigins: [],
        printers: [],
        bambu: {
          printers: [
            {
              printerKey: 'fixture',
              serial: 'SYNTHETIC',
              host: sim.host,
              port: sim.port,
              credentialFile,
              caFile,
              allowedEndpoints: [{ host: sim.host, port: sim.port }],
            },
          ],
        },
      }),
      queue,
      signal: controller.signal,
      onDiagnostic() {},
    })
    try {
      const states = () =>
        queue
          .batch(Date.now(), 100)
          .records.flatMap((record) =>
            record.kind === 'printer-state' ? [record.state] : [],
          )
      const deadline = Date.now() + 8000
      while (
        (states().length < 4 || !states().some((state) => state.machine)) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 50))
      const queued = states()
      expect(queued.length).toBeGreaterThan(1)
      const withMachine = queued.filter((state) => state.machine)
      expect(withMachine).toHaveLength(1)
      expect(withMachine[0]!.machine).toEqual({ nozzleDiametersMm: [0.4] })
    } finally {
      controller.abort()
      await done
      queue.close()
    }
  }, 20_000)

  it('queues no machine block when the printer reports no nozzle', async () => {
    const directory = temporary()
    const sim = await startBambuSimulator({ initialState: 'IDLE' })
    closers.push(() => sim.close())
    const credentialFile = join(directory, 'credentials.json')
    const caFile = join(directory, 'ca.pem')
    writeFileSync(credentialFile, JSON.stringify({ accessCode: 'secret' }), {
      mode: 0o600,
    })
    writeFileSync(caFile, sim.syntheticTrust)
    const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
    const controller = new AbortController()
    const done = collectIntoQueue({
      config: parseLocalCollectorConfig({
        version: 3,
        allowedOrigins: [],
        printers: [],
        bambu: {
          printers: [
            {
              printerKey: 'fixture',
              serial: 'SYNTHETIC',
              host: sim.host,
              port: sim.port,
              credentialFile,
              caFile,
              allowedEndpoints: [{ host: sim.host, port: sim.port }],
            },
          ],
        },
      }),
      queue,
      signal: controller.signal,
      onDiagnostic() {},
    })
    try {
      const states = () =>
        queue
          .batch(Date.now(), 100)
          .records.flatMap((record) =>
            record.kind === 'printer-state' ? [record.state] : [],
          )
      const deadline = Date.now() + 8000
      while (states().length < 3 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50))
      expect(states().length).toBeGreaterThanOrEqual(1)
      expect(states().some((state) => 'machine' in state)).toBe(false)
    } finally {
      controller.abort()
      await done
      queue.close()
    }
  }, 20_000)
})

describe('reported model profiles', () => {
  it('uses only the reported Creality model, even with temperatures present', () => {
    const report = decodeCrealityStatus(
      '{"state":0,"model":"K1","nozzleTemp":22,"nozzleTemp2":220,"bedTemp2":55}',
    )
    expect(reportedModelProfile(report?.model)).toEqual({ model: 'K1' })
    expect(
      reportedModelProfile(decodeCrealityStatus('{"state":0}')?.model),
    ).toBeUndefined()
  })

  it('has no profile fields in Anycubic live temperature telemetry', () => {
    const report = decodeAnycubicReport(
      Buffer.from(
        '{"state":"idle","curr_nozzle_temp":22,"curr_hotbed_temp":23}',
      ),
    )
    expect(report).toMatchObject({
      toolTemperatureCelsius: 22,
      bedTemperatureCelsius: 23,
    })
    expect(report).not.toHaveProperty('machine')
  })

  it('uses the Kobra X model identifier without a model lookup', () => {
    expect(reportedModelProfile('20030')).toEqual({ model: '20030' })
    expect(reportedModelProfile(undefined)).toBeUndefined()
  })
})
