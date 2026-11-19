import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createHash, X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  answerBambuDetailQuery,
  BAMBU_DETAIL_CAPABILITIES,
  createBambuDetailState,
  createBambuDetailStream,
  createBambuSdCard,
} from '../../packages/connector/src/bambu/printer-detail.ts'
import { bambuFtps } from '../../packages/connector/src/bambu/ftps-ops.ts'
import { PrinterDetailQueryKind } from '../../packages/farm-protocol/src/printer-detail.ts'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'

type Frame = {
  capabilities: string[]
  detail: Record<string, any>
}
const report = (print: object) => JSON.stringify({ print })
const ingest = (print: object) =>
  createBambuDetailState('printer-1').ingest(report(print)) as Frame

type Simulator = Awaited<ReturnType<typeof startBambuSimulator>>
const simulators: Simulator[] = []
afterEach(async () => {
  await Promise.all(simulators.splice(0).map((sim) => sim.close()))
})
async function simulator(options: Parameters<typeof startBambuSimulator>[0]) {
  const sim = await startBambuSimulator({ initialState: 'IDLE', ...options })
  simulators.push(sim)
  return sim
}
const ftpsOptions = (sim: Simulator, accessCode = 'secret') => ({
  host: sim.host,
  port: sim.ftpsPort,
  serial: 'SYNTHETIC',
  accessCode,
  trust: { caPem: sim.syntheticTrust },
})
const pinOf = (pem: string) =>
  createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')
const signal = () => new AbortController().signal

describe('Bambu detail stream frames', () => {
  it('reports temperatures', () => {
    const frame = ingest({
      nozzle_temper: 210.5,
      nozzle_target_temper: 215,
      bed_temper: 60,
      bed_target_temper: 65,
      chamber_temper: 32,
    })
    expect(frame.detail.heaters).toEqual([
      { name: 'extruder', temperature: 210.5, target: 215, power: 0 },
      { name: 'bed', temperature: 60, target: 65, power: 0 },
      { name: 'chamber', temperature: 32, target: 0, power: 0 },
    ])
    expect(frame.capabilities).toEqual([...BAMBU_DETAIL_CAPABILITIES])
    for (const unsupported of [
      'bed-mesh',
      'job-queue',
      'power',
      'updates',
      'system',
    ])
      expect(frame.capabilities).not.toContain(unsupported)
  })

  it('reports fans', () => {
    const frame = ingest({
      cooling_fan_speed: '15',
      big_fan1_speed: 0,
      big_fan2_speed: '15',
    })
    expect(frame.detail.fans).toEqual([
      { name: 'part', speed: 1 },
      { name: 'aux', speed: 0 },
      { name: 'chamber', speed: 1 },
    ])
  })

  it('reports the chamber light', () => {
    const on = ingest({
      lights_report: [{ node: 'chamber_light', mode: 'on' }],
    })
    expect(on.detail.lights).toEqual([
      { name: 'chamber_light', red: 1, green: 1, blue: 1 },
    ])
    const off = ingest({
      lights_report: [{ node: 'chamber_light', mode: 'off' }],
    })
    expect(off.detail.lights?.[0]).toMatchObject({ red: 0 })
    expect(ingest({ nozzle_temper: 1 }).detail.lights).toBeUndefined()
  })

  it('reports speed levels as the documented percentages', () => {
    const factors = [1, 2, 3, 4].map(
      (spd_lvl) => ingest({ spd_lvl }).detail.speedFactor,
    )
    expect(factors).toEqual([0.5, 1, 1.24, 1.66])
    expect(ingest({ spd_lvl: 2, spd_mag: 130 }).detail.speedFactor).toBe(1.3)
    expect(ingest({ spd_lvl: 9 }).detail.speedFactor).toBeUndefined()
  })

  it('reports print status with layers and keeps deltas', () => {
    const state = createBambuDetailState('printer-1')
    state.ingest(
      report({
        gcode_state: 'RUNNING',
        subtask_name: 'benchy',
        layer_num: 12,
        total_layer_num: 240,
        ams: { ams: [{ id: 0, tray: [{ id: 0, tray_type: 'PLA' }] }] },
      }),
    )
    const frame = state.ingest(report({ layer_num: 13 })) as Frame
    expect(frame.detail.print).toEqual({
      state: 'printing',
      message: '',
      elapsedSeconds: 0,
      file: 'benchy',
      currentLayer: 13,
      totalLayers: 240,
    })
    // A partial AMS report keeps the slots it does not mention.
    state.ingest(
      report({
        ams: { ams: [{ id: 0, tray: [{ id: 1, tray_type: 'PETG' }] }] },
      }),
    )
    expect(
      (state.print.ams as { ams: { tray: unknown[] }[] }).ams[0]?.tray,
    ).toHaveLength(2)
    expect(
      (state.ingest(report({ gcode_state: 'WEIRD' })) as Frame).detail.print
        .state,
    ).toBe('unknown')
  })

  it('ignores non-telemetry reports and never invents unsupported data', () => {
    const state = createBambuDetailState('printer-1')
    expect(
      state.ingest(JSON.stringify({ info: { command: 'get_version' } })),
    ).toBe(undefined)
    expect(state.ingest('{not json')).toBe(undefined)
    const frame = ingest({ gcode_state: 'IDLE' })
    for (const absent of ['toolhead', 'bedMesh', 'updates', 'host', 'firmware'])
      expect(frame.detail[absent]).toBeUndefined()
  })
})

describe('Bambu SD card over FTPS', () => {
  it('lists, downloads and deletes SD card files over FTPS', async () => {
    const sim = await simulator({})
    sim.uploadFile('benchy.3mf', Buffer.from('3mf-bytes'))
    sim.uploadFile('part.gcode', Buffer.from('G1'))
    const card = createBambuSdCard(ftpsOptions(sim))
    const files = await card.list('root', signal())
    expect(files.map((file) => file.name).sort()).toEqual([
      'benchy.3mf',
      'part.gcode',
    ])
    expect(files.find((file) => file.name === 'benchy.3mf')?.size).toBe(9)
    expect(
      (await card.download('root', 'benchy.3mf', signal())).toString(),
    ).toBe('3mf-bytes')
    await card.remove('root', 'benchy.3mf', signal())
    expect(sim.uploads.has('benchy.3mf')).toBe(false)
    expect(
      (await card.list('root', signal())).map((file) => file.name),
    ).toEqual(['part.gcode'])
  })

  it('refuses unsafe names, wrong credentials, missing files and oversize downloads', async () => {
    const sim = await simulator({})
    sim.uploadFile('big.3mf', Buffer.alloc(2048, 1))
    sim.uploadFile('keep.3mf', Buffer.from('x'))
    const card = createBambuSdCard(ftpsOptions(sim))
    for (const name of ['../etc/passwd', 'a/b.3mf', '', 'x\r\nDELE keep.3mf'])
      await expect(card.remove('root', name, signal())).rejects.toThrow(
        'Invalid Bambu FTPS request',
      )
    // Only file kinds the page lists may be deleted.
    await expect(card.remove('root', 'notes.txt', signal())).rejects.toThrow(
      'Invalid Bambu FTPS request',
    )
    await expect(card.remove('root', 'gone.3mf', signal())).rejects.toThrow(
      'rejected',
    )
    await expect(card.download('root', 'gone.3mf', signal())).rejects.toThrow(
      'rejected',
    )
    await expect(
      bambuFtps(
        { ...ftpsOptions(sim), signal: signal() },
        { op: 'download', folder: 'root', name: 'big.3mf', maxBytes: 1024 },
      ),
    ).rejects.toThrow()
    await expect(
      createBambuSdCard(ftpsOptions(sim, 'wrong')).list('root', signal()),
    ).rejects.toThrow('rejected')
    const aborted = new AbortController()
    aborted.abort()
    await expect(card.list('root', aborted.signal)).rejects.toThrow()
    expect(sim.uploads.has('keep.3mf')).toBe(true)
  })

  it('lists timelapse files over FTPS', async () => {
    const sim = await simulator({})
    sim.uploadTimelapse('print-1.mp4', Buffer.from('video'))
    sim.uploadTimelapse('print-1.jpg', Buffer.from('thumb'))
    sim.uploadFile('benchy.3mf', Buffer.from('3mf'))
    const card = createBambuSdCard(ftpsOptions(sim))
    const query = await answerBambuDetailQuery(
      'timelapse',
      card,
      { ipcam: { timelapse: 'enable' } },
      signal(),
    )
    expect(query).toEqual({
      data: {
        enabled: true,
        rendering: false,
        files: ['timelapse/print-1.jpg', 'timelapse/print-1.mp4'],
      },
    })
    expect(
      (await card.download('timelapse', 'print-1.mp4', signal())).toString(),
    ).toBe('video')
    await card.remove('timelapse', 'print-1.jpg', signal())
    expect([...sim.timelapse.keys()]).toEqual(['print-1.mp4'])
    // The 3mf in the root folder is never listed as a timelapse.
    expect(sim.uploads.has('benchy.3mf')).toBe(true)
    const files = await answerBambuDetailQuery('files', card, {}, signal())
    expect(files).toMatchObject({ data: [{ path: 'benchy.3mf', bytes: 3 }] })
  })

  it('answers unsupported detail queries without touching the printer', async () => {
    const card = createBambuSdCard({
      host: '127.0.0.1',
      serial: 'SYNTHETIC',
      accessCode: 'secret',
      trust: { pinSha256: 'a'.repeat(64) },
      port: 1,
    })
    for (const kind of PrinterDetailQueryKind.options)
      if (kind !== 'files' && kind !== 'timelapse')
        expect(await answerBambuDetailQuery(kind, card, {}, signal())).toEqual({
          error: 'unsupported',
        })
    expect(await answerBambuDetailQuery('files', card, {}, signal())).toEqual({
      error: 'unavailable',
    })
  })
})

describe('Bambu detail stream over the simulator', () => {
  it('streams one lazy read-only connection and releases it', async () => {
    const sim = await simulator({ initialTargetTemperature: 220 })
    const directory = mkdtempSync(join(tmpdir(), 'bambu-detail-'))
    const credentialFile = join(directory, 'credential.json')
    writeFileSync(credentialFile, JSON.stringify({ accessCode: 'secret' }))
    chmodSync(credentialFile, 0o600)
    const stream = createBambuDetailStream({
      binding: {
        printerKey: 'printer-1',
        serial: 'SYNTHETIC',
        host: sim.host,
        port: sim.port,
        control: false,
        ftpsPort: sim.ftpsPort,
        credentialFile,
        pinSha256: pinOf(sim.syntheticTrust),
        allowedEndpoints: [{ host: sim.host, port: sim.port }],
      } as never,
    })
    expect(stream.active).toBe(false)
    const frames: Frame[] = []
    const stop = stream.subscribe((frame) => frames.push(frame as Frame))
    expect(stream.active).toBe(true)
    for (let i = 0; i < 200 && !frames.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 25))
    expect(frames[0]?.detail.heaters?.[0]).toMatchObject({
      name: 'extruder',
      temperature: 210,
      target: 220,
    })
    // Nothing but the version request was published: the stream is read-only.
    expect(
      sim.requests.every((request) => request.command === 'get_version'),
    ).toBe(true)
    stop()
    stop()
    expect(stream.active).toBe(false)
  })
})
