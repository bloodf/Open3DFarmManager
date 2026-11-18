// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import {
  startMoonrakerMock,
  startMock,
} from '../../packages/sim-tools/src/mocks/index.ts'
import { probePrinter } from '../../packages/sim-tools/src/probe.ts'
import {
  verifyFourTools,
  verifyToolSwitching,
  verifyWebcam,
} from '../../packages/sim-tools/src/verify.ts'
import { runSmoke } from '../../packages/sim-tools/src/cli.ts'
import {
  openMoonrakerClient,
  readMoonrakerReady,
  MoonrakerClientError,
  validateMoonrakerInput,
} from '../../packages/connector/src/moonraker/client.ts'
import { discoverMoonraker } from '../../packages/connector/src/moonraker/discovery.ts'
import {
  listMoonrakerFiles,
  createThumbnailDownload,
} from '../../packages/connector/src/moonraker/files.ts'
import {
  uploadMoonrakerFile,
  MoonrakerUploadError,
} from '../../packages/connector/src/moonraker/upload.ts'
import { createMoonrakerSession } from '../../packages/connector/src/moonraker/auth.ts'
import { readMoonrakerFirmware } from '../../packages/connector/src/moonraker/firmware.ts'
import { buildMoonrakerCommand } from '../../packages/connector/src/moonraker/commands.ts'
import { startMoonrakerSimulator } from '../journey/moonraker-simulator.ts'
import { RtcFixtureReply } from '../helpers/signalling-rtc-connector-child.ts'

const execFileAsync = promisify(execFile)

const LIMITS = {
  maxMessageBytes: 64 * 1024,
  connectTimeoutMs: 2000,
  requestTimeoutMs: 2000,
  staleAfterMs: 5000,
  reconnectMinMs: 100,
  reconnectMaxMs: 1000,
}

async function wsRpc(origin, method, params, headers = {}) {
  const { createRequire } = await import('node:module')
  const WebSocket = createRequire(
    new URL('../../packages/connector/package.json', import.meta.url),
  )('ws')
  return await new Promise((resolve, reject) => {
    const wsUrl = origin.replace('http:', 'ws:') + '/websocket'
    const ws = new WebSocket(wsUrl, { headers })
    ws.on('error', reject)
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id === 1) {
        ws.close()
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  })
}

test('sim:smoke CLI passes against mock with OPENFARM_SIM=mock and preserves docker opt-in', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['packages/sim-tools/src/cli.ts'],
    {
      env: { ...process.env, OPENFARM_SIM: 'mock' },
      timeout: 15_000,
    },
  )
  assert.equal(stderr, '')
  assert.match(
    stdout,
    /SIM_SMOKE_READY: sv06 Moonraker connected and Klipper ready/,
  )
  assert.match(
    stdout,
    /SIM_SMOKE_READY: u1 Moonraker connected and Klipper ready/,
  )

  const prev = process.env.OPENFARM_SIM
  process.env.OPENFARM_SIM = 'docker'
  try {
    const seen = []
    const ok = await runSmoke(undefined, async (origin) => {
      seen.push(origin)
      return { klippy_connected: true, klippy_state: 'ready' }
    })
    assert.equal(ok, true)
    assert.deepEqual(seen, ['http://127.0.0.1:7125', 'http://127.0.0.1:7126'])
  } finally {
    if (prev === undefined) delete process.env.OPENFARM_SIM
    else process.env.OPENFARM_SIM = prev
  }
})

test('SV06 and U1 profiles match Docker simulator capabilities and pass discovery + sim-tools verification', async () => {
  const sv06 = await startMock('moonraker', { profile: 'sv06' })
  const u1 = await startMock('moonraker', { profile: 'u1', restartDelayMs: 20 })
  try {
    const svInfo = await Effect.runPromise(probePrinter(sv06.origin))
    assert.equal(svInfo.klippy_connected, true)
    assert.equal(svInfo.klippy_state, 'ready')

    const svDiscovery = await discoverMoonraker({
      origin: sv06.origin,
      webcamOrigin: 'http://127.0.0.1:8110',
      limits: LIMITS,
      signal: new AbortController().signal,
      client: { name: 'test', version: '1', url: 'https://test.local' },
    })
    assert.equal(svDiscovery.tools.tools.length, 1)
    assert.equal(svDiscovery.tools.activeObject, 'extruder')
    assert.equal(svDiscovery.webcams[0]?.name, 'sv06-test-pattern')

    assert.equal(await verifyFourTools(u1.origin), 9)
    assert.equal(
      await verifyToolSwitching(u1.origin, {
        pollMs: 10,
        restartTimeoutMs: 2000,
      }),
      3,
    )
    assert.equal(await verifyWebcam(u1.origin), 1)

    const u1Discovery = await discoverMoonraker({
      origin: u1.origin,
      webcamOrigin: 'http://127.0.0.1:8111',
      limits: LIMITS,
      signal: new AbortController().signal,
      client: { name: 'test', version: '1', url: 'https://test.local' },
    })
    assert.equal(u1Discovery.tools.tools.length, 4)
    assert.equal(u1Discovery.webcams[0]?.name, 'u1-test-pattern')
  } finally {
    await sv06.close()
    await u1.close()
  }
})

test('Print lifecycle (standby, printing, pause, resume, cancel, complete, error) and macro calls', async () => {
  const mock = await startMoonrakerMock({
    profile: 'sv06',
    objects: [
      'webhooks',
      'print_stats',
      'virtual_sdcard',
      'extruder',
      'heater_bed',
      'fan',
      'fan_generic aux',
      'output_pin caselight',
      'gcode_macro LOAD_FILAMENT',
      'gcode_macro CLEAN_NOZZLE',
    ],
  })
  const controller = new AbortController()
  const deltas = []
  try {
    const client = openMoonrakerClient({
      origin: mock.origin,
      limits: LIMITS,
      signal: controller.signal,
      onStatus: (params) => deltas.push(params),
    })

    const initial = await client.snapshot
    assert.equal(initial.status.print_stats.state, 'standby')

    // Start print
    await wsRpc(mock.origin, 'printer.print.start', {
      filename: 'benchy.gcode',
    })
    assert.equal(mock.control.model().state, 'printing')
    assert.equal(mock.control.model().filename, 'benchy.gcode')

    // Progress & temperature update
    mock.control.update({ progress: 0.45, extruder: 215, bed: 60 })

    // Pause -> Resume -> Cancel
    await wsRpc(mock.origin, 'printer.print.pause')
    assert.equal(mock.control.model().state, 'paused')

    await wsRpc(mock.origin, 'printer.print.resume')
    assert.equal(mock.control.model().state, 'printing')

    await wsRpc(mock.origin, 'printer.print.cancel')
    assert.equal(mock.control.model().state, 'cancelled')

    // Complete & Error transitions
    mock.control.completePrint()
    assert.equal(mock.control.model().state, 'complete')
    assert.equal(mock.control.model().progress, 1)

    await wsRpc(mock.origin, 'printer.emergency_stop')
    assert.equal(mock.control.model().state, 'error')

    // Macros and extended commands recorded
    const listRes = await wsRpc(mock.origin, 'printer.objects.list')
    const cmdTemp = buildMoonrakerCommand(
      'set_temperature',
      { heater: 'extruder', target_c: 210 },
      listRes.objects,
    )
    const cmdMacro = buildMoonrakerCommand(
      'run_macro',
      { name: 'CLEAN_NOZZLE' },
      listRes.objects,
    )
    const cmdLight = buildMoonrakerCommand(
      'set_light',
      { on: true },
      listRes.objects,
    )
    await wsRpc(mock.origin, cmdTemp.method, cmdTemp.params)
    await wsRpc(mock.origin, cmdMacro.method, cmdMacro.params)
    await wsRpc(mock.origin, cmdLight.method, cmdLight.params)

    assert.deepEqual(mock.control.gcodeScripts, [
      'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=210',
      'CLEAN_NOZZLE',
      'SET_PIN PIN=caselight VALUE=1',
    ])
    assert.equal(mock.control.macroCalls.length, 3)
    assert.equal(mock.control.model().extruderTarget, 210)
    assert.equal(mock.control.model().caselight, 1)

    // Subscriber received status deltas
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(deltas.length >= 5)

    client.close()
    await client.closed
  } finally {
    controller.abort()
    await mock.close()
  }
})

test('HTTP files, upload, firmware, and /access/* JWT + API key auth work with Connector adapters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e16-352-auth-'))
  const pngThumb = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
  const mock = await startMoonrakerMock({
    auth: {
      username: 'operator',
      password: 'secret-password',
      apiKey: 'secret-api-key',
      tokenTtlSeconds: 30,
    },
    maxUploadBytes: 128,
    files: [
      {
        path: 'models/part.gcode',
        content: 'G28\nG1 X10\n',
        modified: 1700000100,
        estimatedTime: 180,
        thumbnails: [{ relativePath: '.thumbs/part.png', content: pngThumb }],
      },
    ],
    firmware: {
      klipper: { version: 'v0.12.0', remote_version: 'v0.12.1' },
      moonraker: { version: 'v0.9.3', remote_version: 'v0.9.3' },
    },
  })

  try {
    // 1. Unauthenticated access rejected with 401
    const unauth = await fetch(`${mock.origin}/server/info`)
    assert.equal(unauth.status, 401)

    // 2. Bad password rejected
    const badSession = createMoonrakerSession({
      origin: mock.origin,
      username: 'operator',
      password: 'wrong',
    })
    await assert.rejects(badSession.getAuthHeaders(), /401/)

    // 3. Valid JWT credential file works through Connector validateMoonrakerInput + readMoonrakerReady + openMoonrakerClient
    const credPath = join(dir, 'jwt-cred.json')
    await writeFile(
      credPath,
      JSON.stringify({
        origin: mock.origin,
        username: 'operator',
        password: 'secret-password',
      }),
      { mode: 0o600 },
    )
    const checked = validateMoonrakerInput({
      assignment: {
        printerKey: 'p1',
        origin: mock.origin,
        apiKeyFile: credPath,
      },
      allowedOrigins: [mock.origin],
      limits: LIMITS,
    })

    const signal = new AbortController().signal
    await readMoonrakerReady({ ...checked, signal })

    const client = openMoonrakerClient({
      ...checked,
      signal,
      onStatus: () => {},
    })
    const snap = await client.snapshot
    assert.equal(snap.status.print_stats.state, 'standby')
    client.close()
    await client.closed

    // 4. File listing + thumbnail download + metadata + firmware
    const session = createMoonrakerSession({
      origin: mock.origin,
      username: 'operator',
      password: 'secret-password',
    })
    const authHeaders = await session.getAuthHeaders()
    const files = await listMoonrakerFiles(
      {
        request: (method, params) =>
          wsRpc(mock.origin, method, params, { 'X-Api-Key': 'secret-api-key' }),
        downloadThumbnail: createThumbnailDownload({
          origin: mock.origin,
          limits: validateMoonrakerInput({
            assignment: {
              printerKey: 'p1',
              origin: mock.origin,
              apiKeyFile: credPath,
            },
            allowedOrigins: [mock.origin],
            limits: LIMITS,
          }).limits,
          signal,
        }),
      },
      { limit: 10 },
    )
    assert.equal(files.length, 1)
    assert.equal(files[0]?.name, 'models/part.gcode')
    assert.equal(files[0]?.estimatedTime, 180)
    assert.equal(files[0]?.thumbnail, pngThumb.toString('base64'))

    const fw = await readMoonrakerFirmware({
      request: (method, params) =>
        wsRpc(mock.origin, method, params, authHeaders),
    })
    assert.equal(fw?.updateAvailable, true)
    assert.equal(fw?.current, 'v0.12.0')

    // 5. Upload (ok, unauthorized, too-large)
    const gcodeFile = join(dir, 'upload.gcode')
    await writeFile(gcodeFile, 'G28\nM104 S200\n')
    await uploadMoonrakerFile({
      origin: mock.origin,
      apiKey: 'secret-api-key',
      filePath: gcodeFile,
      name: 'upload.gcode',
      signal,
    })
    assert.ok(mock.control.files.has('upload.gcode'))

    await assert.rejects(
      uploadMoonrakerFile({
        origin: mock.origin,
        apiKey: 'wrong-key',
        filePath: gcodeFile,
        name: 'upload.gcode',
        signal,
      }),
      (err) =>
        err instanceof MoonrakerUploadError && err.reason === 'unauthorized',
    )

    const bigFile = join(dir, 'big.gcode')
    await writeFile(bigFile, 'G1 X1 Y1\n'.repeat(30))
    await assert.rejects(
      uploadMoonrakerFile({
        origin: mock.origin,
        apiKey: 'secret-api-key',
        filePath: bigFile,
        name: 'big.gcode',
        signal,
      }),
      (err) =>
        err instanceof MoonrakerUploadError && err.reason === 'too-large',
    )
  } finally {
    await mock.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Faults: Klippy not ready, shutdown notification, disconnect mid-print, and slow replies', async () => {
  const mock = await startMoonrakerMock({ restartDelayMs: 20 })
  try {
    // 1. Klippy not ready
    mock.control.setKlippyState('startup', {
      connected: true,
      message: 'Starting',
    })
    await assert.rejects(
      readMoonrakerReady({
        origin: mock.origin,
        limits: LIMITS,
        signal: new AbortController().signal,
      }),
      (err) =>
        err instanceof MoonrakerClientError && err.reason === 'not-ready',
    )
    const queryNotReady = await fetch(
      `${mock.origin}/printer/objects/query?print_stats`,
    )
    assert.equal(queryNotReady.status, 503)

    mock.control.setKlippyState('ready')
    await readMoonrakerReady({
      origin: mock.origin,
      limits: LIMITS,
      signal: new AbortController().signal,
    })

    // 2. Shutdown emits notify_klippy_shutdown -> client rejects with 'not-ready'
    const c1 = openMoonrakerClient({
      origin: mock.origin,
      limits: LIMITS,
      signal: new AbortController().signal,
      onStatus: () => {},
    })
    await c1.snapshot
    mock.control.setKlippyState('shutdown', { message: 'MCU shutdown' })
    assert.equal(await c1.closed, 'not-ready')

    // Recover via /printer/restart
    const restart = await fetch(`${mock.origin}/printer/restart`, {
      method: 'POST',
    })
    assert.equal(restart.status, 200)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(mock.control.model().klippyState, 'ready')

    // 3. Disconnect mid-print
    await wsRpc(mock.origin, 'printer.print.start', { filename: 'mid.gcode' })
    const c2 = openMoonrakerClient({
      origin: mock.origin,
      limits: LIMITS,
      signal: new AbortController().signal,
      onStatus: () => {},
    })
    await c2.snapshot
    mock.control.disconnectClients()
    assert.equal(await c2.closed, 'offline')

    // 4. Slow replies
    mock.control.faults.setFault({
      type: 'delay',
      delayMs: 250,
      path: '/server/info',
    })
    await assert.rejects(
      readMoonrakerReady({
        origin: mock.origin,
        limits: { ...LIMITS, requestTimeoutMs: 50 },
        signal: new AbortController().signal,
      }),
      (err) => err instanceof MoonrakerClientError && err.reason === 'offline',
    )
    mock.control.faults.clearFaults()
  } finally {
    await mock.close()
  }
})

test('Replaced journey moonraker-simulator and signalling-runtime-moonraker delegate to shared mock cleanly', async () => {
  const sim = await startMoonrakerSimulator()
  try {
    assert.equal(sim.model().state, 'printing')
    assert.equal(sim.model().progress, 0.25)
    const spoolRes = await fetch(`${sim.spoolmanOrigin}/api/v1/spool`)
    assert.equal(spoolRes.status, 200)
    assert.deepEqual(await spoolRes.json(), [])
    sim.update({ progress: 0.75 })
    assert.equal(sim.model().progress, 0.75)
  } finally {
    await sim.close()
  }

  const envKeys = [
    'SIGNALLING_HTTPS_RTC_RUNTIME',
    'WS_NO_BUFFER_UTIL',
    'WS_NO_UTF_8_VALIDATE',
  ]
  const prev = envKeys.map((k) => process.env[k])
  process.env.SIGNALLING_HTTPS_RTC_RUNTIME = 'yes'
  process.env.WS_NO_BUFFER_UTIL = '1'
  process.env.WS_NO_UTF_8_VALIDATE = '1'
  try {
    const { createRuntimeMoonrakerFixture } =
      await import('../helpers/signalling-runtime-moonraker.ts')
    const fixture = await createRuntimeMoonrakerFixture()
    try {
      const obs = fixture.observe()
      assert.deepEqual(RtcFixtureReply.parse(obs), obs)
    } finally {
      await fixture.close()
    }
  } finally {
    for (const [i, k] of envKeys.entries()) {
      if (prev[i] === undefined) delete process.env[k]
      else process.env[k] = prev[i]
    }
  }
})
