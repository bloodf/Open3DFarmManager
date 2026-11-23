// SPDX-License-Identifier: MIT
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash, X509Certificate } from 'node:crypto'
import type * as Ws from 'ws'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'

const require = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)
const { WebSocketServer } = require('ws') as typeof Ws

function runCli(args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [
        'scripts/qualify-printer.ts',
        ...args,
      ])
      let out = ''
      let err = ''
      child.stdout.on('data', (data) => {
        out += data.toString()
      })
      child.stderr.on('data', (data) => {
        err += data.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, out, err }))
    },
  )
}

test('CLI safety: strictly refuses actuator and command execution flags', async () => {
  for (const flag of [
    '--pause',
    '--resume',
    '--stop',
    '--cancel',
    '--command=test',
    '--send',
    '--execute',
    '--gcode',
    '--move',
    '--extrude',
    '--home',
  ]) {
    const result = await runCli([
      '--vendor',
      'moonraker',
      '--host',
      '127.0.0.1',
      flag,
    ])
    assert.equal(result.code, 2)
    assert.match(
      result.err,
      /Safety violation: Command execution flag '.*' is forbidden/,
    )
    assert.equal(result.out, '')
  }
})

test('CLI arguments: help displays usage and missing required options fail with code 2', async () => {
  const helpResult = await runCli(['--help'])
  assert.equal(helpResult.code, 0)
  assert.ok(helpResult.out.includes('Usage: node scripts/qualify-printer.ts'))
  assert.ok(helpResult.out.includes('anycubic=9883'))

  const noArgs = await runCli([])
  assert.equal(noArgs.code, 2)
  assert.match(noArgs.err, /Missing required parameters/)

  const missingHost = await runCli(['--vendor', 'bambu'])
  assert.equal(missingHost.code, 2)
  assert.match(missingHost.err, /Missing required parameters/)

  const unknownVendor = await runCli([
    '--vendor',
    'invalid-vendor',
    '--host',
    '127.0.0.1',
  ])
  assert.equal(unknownVendor.code, 1)
  assert.match(unknownVendor.err, /Unsupported printer vendor/)
})

test('qualify Moonraker printer against fixture with telemetry, camera and files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moonraker-qualify-'))

  // 1. Camera snapshot HTTP server
  const jpegHeader = Buffer.from([255, 216, 1, 2, 255, 217])
  const camServer = createHttpServer((req, res) => {
    if (req.url === '/webcam/?action=snapshot' || req.url === '/foreign') {
      res.writeHead(200, { 'content-type': 'image/jpeg' })
      res.end(jpegHeader)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) =>
    camServer.listen(0, '127.0.0.1', resolve),
  )
  const camAddr = camServer.address()
  assert.ok(camAddr && typeof camAddr !== 'string')
  const camPort = camAddr.port

  // 2. Moonraker WebSocketServer
  const moonServer = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => moonServer.once('listening', resolve))
  const moonAddr = moonServer.address()
  assert.ok(moonAddr && typeof moonAddr !== 'string')
  const moonPort = moonAddr.port

  let hostname = 'sovol-sv08'
  moonServer.on('connection', (socket: Ws.WebSocket) => {
    socket.on('message', (data: Ws.RawData) => {
      const rpc = JSON.parse(data.toString())
      let result: unknown = {}
      if (rpc.method === 'server.connection.identify') {
        result = { connection_id: 42 }
      } else if (rpc.method === 'server.info') {
        result = {
          klippy_connected: true,
          klippy_state: 'ready',
          moonraker_version: 'v0.8.0',
        }
      } else if (rpc.method === 'printer.objects.list') {
        result = { objects: ['toolhead', 'extruder', 'extruder1'] }
      } else if (rpc.method === 'printer.objects.query') {
        result = {
          status: {
            toolhead: { extruder: 'extruder' },
            extruder: { temperature: 215, target: 215 },
            extruder1: { temperature: 24, target: 0 },
          },
        }
      } else if (rpc.method === 'printer.info') {
        result = { software_version: 'v0.12.0', hostname }
      } else if (rpc.method === 'machine.system_info') {
        result = { system_info: { hostname } }
      } else if (rpc.method === 'server.webcams.list') {
        result = {
          webcams: [
            {
              name: 'case',
              snapshot_url: `http://127.0.0.1:${camPort}/foreign`,
            },
            { name: 'broken', snapshot_url: '/missing' },
            {
              name: 'default',
              snapshot_url: '/webcam/?action=snapshot',
              stream_url: '/webcam/?action=stream',
            },
          ],
        }
      } else if (rpc.method === 'server.files.list') {
        result = [
          { path: 'test_cube.gcode', size: 120400, modified: 1731600000 },
          { path: 'benchy.gcode', size: 3450000, modified: 1731600500 },
        ]
      } else if (rpc.method === 'server.files.metadata') {
        result = { estimated_time: 1800 }
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
  })

  try {
    const res = await runCli([
      '--vendor',
      'moonraker',
      '--host',
      '127.0.0.1',
      '--port',
      String(moonPort),
      '--camera-port',
      String(camPort),
    ])

    assert.equal(res.code, 0, res.err)
    const report = JSON.parse(res.out)

    assert.equal(report.vendor, 'moonraker')
    assert.equal(report.host, '127.0.0.1')
    assert.equal(report.port, moonPort)
    assert.equal(report.identity.vendor, 'Klipper')
    assert.equal(report.identity.firmware, 'Klipper v0.12.0; Moonraker v0.8.0')
    assert.equal(report.identity.model, 'Sovol SV08')
    assert.equal(report.identity.hostname, 'sovol-sv08')

    assert.equal(report.telemetry.observed, true)
    assert.ok(report.telemetry.fields.includes('klippyConnected'))
    assert.ok(report.telemetry.fields.includes('toolTemperatures'))

    assert.equal(report.camera.reachable, true)
    assert.equal(report.camera.kind, 'webcam')
    assert.deepEqual(
      report.camera.webcams.map((c: { name: string; reachable: boolean }) => [
        c.name,
        c.reachable,
      ]),
      [
        ['case', true],
        ['broken', false],
        ['default', true],
      ],
    )

    assert.equal(report.files.listable, true)
    assert.equal(report.files.count, 2)
    assert.equal(report.files.files[0]?.name, 'benchy.gcode')

    assert.equal(report.qualification.status, 'qualified')
    assert.equal(report.catalog.canPromoteToHardwareProven, true)
    assert.equal(report.catalog.matchedCatalogId, 'sovol-sv08')
    const overridden = await runCli([
      '--vendor',
      'moonraker',
      '--host',
      '127.0.0.1',
      '--port',
      String(moonPort),
      '--camera-port',
      String(camPort),
      '--model',
      'Voron 2.4',
    ])
    assert.equal(overridden.code, 0, overridden.err)
    assert.equal(JSON.parse(overridden.out).identity.model, 'Voron 2.4')
    assert.equal(
      JSON.parse(overridden.out).catalog.matchedCatalogId,
      'voron-2-4-kit',
    )
    hostname = 'raspberrypi'
    const generic = await runCli([
      '--vendor',
      'moonraker',
      '--host',
      '127.0.0.1',
      '--port',
      String(moonPort),
      '--camera-port',
      String(camPort),
    ])
    assert.equal(generic.code, 0, generic.err)
    assert.equal(JSON.parse(generic.out).identity.model, 'Moonraker Generic')
  } finally {
    await new Promise<void>((resolve) => moonServer.close(() => resolve()))
    await new Promise<void>((resolve) => camServer.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('qualify Bambu printer against simulator with MQTT reports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bambu-qualify-'))

  // 1. Start Bambu simulator
  let sim: Awaited<ReturnType<typeof startBambuSimulator>> | undefined
  try {
    sim = await startBambuSimulator({
      serial: 'QUALIFY_BAMBU',
      initialState: 'RUNNING',
    })
    const credPath = join(dir, 'bambu-creds.json')
    await writeFile(
      credPath,
      JSON.stringify({
        accessCode: 'synthetic-code',
        serial: 'QUALIFY_BAMBU',
        pinSha256: createHash('sha256')
          .update(new X509Certificate(sim.syntheticTrust).raw)
          .digest('hex'),
        caPem: sim.syntheticTrust,
      }),
      { mode: 0o600 },
    )
    const res = await runCli([
      '--vendor',
      'bambu',
      '--host',
      sim.host,
      '--port',
      String(sim.port),
      '--serial',
      'QUALIFY_BAMBU',
      '--timeout',
      '3000',
      credPath,
    ])

    assert.equal(res.code, 0, res.err)
    const report = JSON.parse(res.out)

    assert.equal(report.vendor, 'bambu')
    assert.equal(report.host, sim.host)
    assert.equal(report.identity.serial, 'QUALIFY_BAMBU')
    assert.equal(report.telemetry.observed, true)
    assert.ok(report.telemetry.fields.includes('state'))
    assert.ok(report.telemetry.fields.includes('progress'))
    assert.ok(
      report.qualification.status === 'qualified' ||
        report.qualification.status === 'partially_qualified',
    )
  } finally {
    await sim?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('qualify Creality printer against simulator with telemetry and camera', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'creality-qualify-'))

  // 1. Start mock camera server
  const jpegHeader = Buffer.from([255, 216, 1, 2, 255, 217])
  const camServer = createHttpServer((req, res) => {
    if (req.url === '/?action=snapshot') {
      res.writeHead(200, { 'content-type': 'image/jpeg' })
      res.end(jpegHeader)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) =>
    camServer.listen(0, '127.0.0.1', resolve),
  )
  const camAddr = camServer.address()
  assert.ok(camAddr && typeof camAddr !== 'string')
  const camPort = camAddr.port

  // 2. Start Creality simulator
  const sim = await createCrealitySimulator({
    state: 1,
    printProgress: 75,
    nozzleTemp: 215,
    bedTemp: 60,
    model: 'K3',
    hostname: 'creality-k3-farm',
    modelVersion: 'CR-K3-1.0.4',
  })

  try {
    const res = await runCli([
      '--vendor',
      'creality',
      '--host',
      '127.0.0.1',
      '--port',
      String(sim.port),
      '--camera-port',
      String(camPort),
      '--timeout',
      '3000',
    ])

    assert.equal(res.code, 0, res.err)
    const report = JSON.parse(res.out)

    assert.equal(report.vendor, 'creality')
    assert.equal(report.identity.model, 'K3')
    assert.equal(report.identity.hostname, 'creality-k3-farm')
    assert.equal(report.identity.firmware, 'CR-K3-1.0.4')

    assert.equal(report.telemetry.observed, true)
    assert.ok(report.telemetry.fields.includes('state'))
    assert.ok(report.telemetry.fields.includes('progress'))
    assert.ok(report.telemetry.fields.includes('nozzleTemp'))
    assert.ok(report.telemetry.fields.includes('bedTemp'))

    assert.equal(report.camera.reachable, true)
    assert.equal(report.camera.kind, 'mjpeg')

    assert.equal(report.catalog.matchedCatalogId, 'creality-k3')
    assert.equal(report.catalog.canPromoteToHardwareProven, true)
    assert.equal(report.qualification.status, 'qualified')
  } finally {
    await sim.close()
    await new Promise<void>((resolve) => camServer.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('qualify Anycubic printer against LAN simulator with telemetry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anycubic-qualify-'))

  let sim: Awaited<ReturnType<typeof startAnycubicSimulator>> | undefined
  try {
    sim = await startAnycubicSimulator({
      serial: 'SYNTHETIC_ANYCUBIC',
      initialState: 'RUNNING',
    })
    const credPath = join(dir, 'anycubic-creds.json')
    await writeFile(
      credPath,
      JSON.stringify({
        username: 'bblp',
        password: 'synthetic-password',
        serial: 'SYNTHETIC_ANYCUBIC',
        caPem: sim.syntheticTrust,
        pinSha256: createHash('sha256')
          .update(new X509Certificate(sim.syntheticTrust).raw)
          .digest('hex'),
      }),
      { mode: 0o600 },
    )
    const res = await runCli([
      '--vendor',
      'anycubic',
      '--host',
      sim.host,
      '--port',
      String(sim.port),
      '--serial',
      'SYNTHETIC_ANYCUBIC',
      '--timeout',
      '3000',
      credPath,
    ])

    assert.equal(res.code, 0, res.err)
    const report = JSON.parse(res.out)

    assert.equal(report.vendor, 'anycubic')
    assert.equal(report.identity.serial, 'SYNTHETIC_ANYCUBIC')
    assert.equal(report.telemetry.observed, true)
    assert.ok(report.telemetry.fields.includes('progress'))
    assert.ok(report.telemetry.fields.includes('state'))
    assert.ok(
      report.qualification.status === 'qualified' ||
        report.qualification.status === 'partially_qualified',
    )
  } finally {
    await sim?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('CLI exit code: an unreachable report is printed and exits 1', async () => {
  // Without bridge credentials the KobraLink client refuses before any request.
  const result = await runCli(['--vendor', 'kobralink', '--host', '127.0.0.1'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.out)
  assert.equal(report.qualification.status, 'unreachable')
  assert.match(report.qualification.summary, /no credential file/)
  assert.deepEqual(report.identity, {})
  assert.equal(report.catalog.matchedCatalogId, null)
})
