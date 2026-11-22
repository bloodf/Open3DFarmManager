import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test, type TestContext } from 'node:test'
import {
  createFlashforgeAdapter,
  discoverFlashforge,
} from '../../packages/connector/src/flashforge/index.ts'
import { startFlashforgeSimulator } from '../../packages/sim-tools/src/flashforge-simulator.ts'

const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/flashforge/detail.json', import.meta.url),
    'utf8',
  ),
)

async function setup(t: TestContext) {
  const detail = { ...fixture.detail }
  const writes: { path: string; packet: unknown }[] = []
  const modes = { write: 'ok' }
  const sim = await startFlashforgeSimulator((req, res, body) => {
    const path = req.url ?? ''
    if (req.method === 'GET' && path === '/?action=stream') {
      res.setHeader(
        'content-type',
        'multipart/x-mixed-replace; boundary=fixture',
      )
      res.end(
        '--fixture\r\nContent-Type: image/jpeg\r\n\r\nfixture-frame\r\n--fixture--\r\n',
      )
      return
    }
    const upload = path === '/uploadGcode'
    const data = upload ? null : JSON.parse(body.toString())
    const serial = upload ? req.headers.serialnumber : data.serialNumber
    const code = upload ? req.headers.checkcode : data.checkCode
    const send = (reply: object) => res.end(JSON.stringify(reply))
    if (
      req.method !== 'POST' ||
      serial !== 'FIXTURE-SERIAL' ||
      code !== 'fixture01'
    ) {
      send({ code: -1 })
      return
    }
    if (path === '/detail') {
      send({ code: 0, detail })
      return
    }
    if (path === '/gcodeList') {
      send(
        detail.pid === '0026'
          ? { code: 0, gcodeListDetail: [{ gcodeFileName: 'fixture.3mf' }] }
          : { code: 0, gcodeList: ['fixture.gcode'] },
      )
      return
    }
    writes.push({
      path,
      packet: upload
        ? {
            size: req.headers.filesize,
            printNow: req.headers.printnow,
            leveling: req.headers.levelingbeforeprint,
            file: /name="gcodeFile"; filename="fixture.gcode"/.test(
              body.toString(),
            ),
            payload: body.includes(Buffer.from('\r\n\r\nG90\n\r\n--')),
          }
        : (data.payload ?? {
            fileName: data.fileName,
            levelingBeforePrint: data.levelingBeforePrint,
          }),
    })
    switch (modes.write) {
      case 'denial':
        send({ code: 2 })
        break
      case 'disconnect':
        req.socket.destroy()
        break
      case 'timeout':
        break
      case 'malformed':
        res.end('{')
        break
      default:
        send({ code: 0 })
    }
  })
  t.after(() => sim.close())
  const credentials = {
    ...sim,
    serialNumber: 'FIXTURE-SERIAL',
    checkCode: 'fixture01',
    timeoutMs: 300,
    cameraPort: sim.port,
  }
  return {
    sim,
    adapter: createFlashforgeAdapter(credentials),
    credentials,
    detail,
    writes,
    modes,
  }
}

test('discovers and reads authenticated 5M Pro telemetry and files', async (t) => {
  const { sim, adapter, credentials, detail } = await setup(t)
  assert.deepEqual(
    await discoverFlashforge({ host: sim.host, port: sim.discoveryPort }),
    {
      model: 'Adventurer 5M Pro',
      serialNumber: 'FIXTURE-SERIAL',
    },
  )
  assert.deepEqual(await adapter.readStatus(), {
    model: 'Adventurer 5M Pro',
    firmware: '5.1.8',
    status: 'printing',
    cameraUrl: 'http://127.0.0.1:8080/?action=stream',
    slots: undefined,
    filename: 'fixture.gcode',
    progress: 0.25,
    nozzle: { current: 205, target: 210 },
    bed: { current: 58, target: 60 },
    coolingFanPercent: 70,
    filtration: { internal: 'open', external: 'close' },
    material: 'PLA',
    estimatedGrams: 12.5,
    errorCode: 'E0048',
  })
  assert.deepEqual(await adapter.listFiles(), ['fixture.gcode'])
  await assert.rejects(
    createFlashforgeAdapter({
      ...credentials,
      checkCode: 'invalid',
    }).readStatus(),
    /rejected/,
  )
  detail.pid = 35
  detail.firmwareVersion = 'v3.2.7'
  detail.cameraStreamUrl = 'http://192.0.2.1:8080/?action=stream'
  const base = await adapter.readStatus()
  assert.equal(base.model, 'Adventurer 5M')
  assert.equal(base.cameraUrl, undefined)
  assert.equal(base.filtration, undefined)
  detail.firmwareVersion = 'v99.99.99'
  await assert.rejects(adapter.readStatus(), /firmware/)
})

test('opens the reported MJPEG source on the bound host', async (t) => {
  const { adapter, detail } = await setup(t)
  const signal = new AbortController().signal
  const result = await adapter.openCamera(signal)
  assert.equal(
    result.contentType,
    'multipart/x-mixed-replace; boundary=fixture',
  )
  assert.match(await new Response(result.body).text(), /fixture-frame/)
  detail.cameraStreamUrl = 'http://192.0.2.1:8080/?action=stream'
  await assert.rejects(adapter.openCamera(signal), /camera unavailable/)
})

test('reads AD5X slots and denies AD5X writes', async (t) => {
  const { adapter, detail, writes } = await setup(t)
  detail.pid = '0026'
  detail.firmwareVersion = '1.2.1'
  detail.hasMatlStation = true
  detail.matlStationInfo = {
    slotInfos: [
      {
        slotId: 2,
        hasFilament: true,
        materialName: 'PETG',
        materialColor: '#113355',
      },
    ],
  }
  assert.deepEqual((await adapter.readStatus()).slots, [
    { id: 2, loaded: true, material: 'PETG', color: '#113355' },
  ])
  assert.deepEqual(await adapter.listFiles(), ['fixture.3mf'])
  await assert.rejects(
    adapter.execute({ kind: 'pause' }, () => true),
    /unavailable on AD5X/,
  )
  assert.deepEqual(writes, [])
})

test('serializes only authorized state-appropriate writes', async (t) => {
  const { adapter, detail, writes } = await setup(t)
  const allow = () => true
  await assert.rejects(
    adapter.execute({ kind: 'pause' }, () => false),
    /action denied/,
  )
  await assert.rejects(
    adapter.execute({ kind: 'start', filename: 'fixture.gcode' }, allow),
    /file action denied/,
  )
  assert.deepEqual(writes, [])
  assert.deepEqual(await adapter.execute({ kind: 'pause' }, allow), {
    acknowledged: true,
  })
  detail.status = 'pause'
  await adapter.execute({ kind: 'resume' }, allow)
  await adapter.execute({ kind: 'cancel' }, allow)
  detail.status = 'printing'
  await adapter.execute({ kind: 'fan', percent: 40 }, allow)
  await adapter.execute(
    { kind: 'temperature', heater: 'bed', celsius: 0 },
    allow,
  )
  detail.status = 'ready'
  await assert.rejects(
    adapter.execute({ kind: 'start', filename: '../fixture.gcode' }, allow),
    /file action denied/,
  )
  await adapter.execute(
    {
      kind: 'upload',
      filename: 'fixture.gcode',
      content: Buffer.from('G90\n'),
    },
    allow,
  )
  await adapter.execute({ kind: 'start', filename: 'fixture.gcode' }, allow)
  assert.deepEqual(writes, [
    {
      path: '/control',
      packet: { cmd: 'jobCtl_cmd', args: { jobID: '', action: 'pause' } },
    },
    {
      path: '/control',
      packet: { cmd: 'jobCtl_cmd', args: { jobID: '', action: 'continue' } },
    },
    {
      path: '/control',
      packet: { cmd: 'jobCtl_cmd', args: { jobID: '', action: 'cancel' } },
    },
    {
      path: '/control',
      packet: { cmd: 'printerCtl_cmd', args: { coolingFan: 40 } },
    },
    {
      path: '/control',
      packet: { cmd: 'temperatureCtl_cmd', args: { platform: -100 } },
    },
    {
      path: '/uploadGcode',
      packet: {
        size: '4',
        printNow: 'false',
        leveling: 'true',
        file: true,
        payload: true,
      },
    },
    {
      path: '/printGcode',
      packet: { fileName: 'fixture.gcode', levelingBeforePrint: true },
    },
  ])
})

test('enforces the 265 C nozzle API ceiling before dispatch', async (t) => {
  const { adapter, writes } = await setup(t)
  const allow = () => true
  await assert.rejects(
    adapter.execute(
      { kind: 'temperature', heater: 'nozzle', celsius: 266 },
      allow,
    ),
    /Flashforge temperature denied/,
  )
  assert.deepEqual(writes, [])

  assert.deepEqual(
    await adapter.execute(
      { kind: 'temperature', heater: 'nozzle', celsius: 265 },
      allow,
    ),
    { acknowledged: true },
  )
  assert.deepEqual(writes, [
    {
      path: '/control',
      packet: { cmd: 'temperatureCtl_cmd', args: { rightNozzle: 265 } },
    },
  ])
})

test('does not resend rejected or uncertain writes', async (t) => {
  const { adapter, writes, modes } = await setup(t)
  const cases = [
    ['denial', /rejected/],
    ['disconnect', /socket hang up/],
    ['timeout', /request timeout/],
    ['malformed', /Malformed Flashforge reply/],
  ] as const
  for (const [mode, error] of cases) {
    modes.write = mode
    const count = writes.length
    await assert.rejects(
      adapter.execute({ kind: 'pause' }, () => true),
      error,
    )
    assert.equal(writes.length, count + 1)
  }
})
