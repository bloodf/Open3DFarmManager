import assert from 'node:assert/strict'
import { createCipheriv, createHash, X509Certificate } from 'node:crypto'
import test from 'node:test'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import {
  connectKobraX,
  discoverKobraX,
} from '../../packages/connector/src/kobra-x/index.ts'
import {
  kobraXCtrlQuery,
  readKobraXInfo,
  recoverKobraXCredentials,
} from '../../packages/connector/src/kobra-x/discovery.ts'
import { createKobraXStatus } from '../../packages/connector/src/kobra-x/status.ts'
import {
  generateWrongKobraXClientCert,
  installNetworkGuard,
  KOBRA_X_PREPARATION_PHASES,
  startKobraXMock,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'

const address = '127.0.0.1'
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await delay(20)
  }
  assert.ok(check(), 'Timed out waiting for Kobra X telemetry')
}

test(
  'Kobra X loopback discovery, mutual TLS, status and reconnect',
  { timeout: 20000 },
  async (t) => {
    installNetworkGuard()
    t.after(uninstallNetworkGuard)
    const mock = await startKobraXMock({
      strictCtrlQuery: true,
      reportIntervalMs: 0,
    })
    const wrong = generateWrongKobraXClientCert()
    let adapter
    t.after(async () => {
      await adapter?.close()
      wrong.cleanup()
      await mock.close()
    })

    const found = await discoverKobraX({
      target: address,
      ssdpPort: mock.ssdpPort,
      httpPort: mock.httpPort,
      timeoutMs: 200,
    })
    assert.equal(found.length, 1)
    assert.equal(found[0].address, address)
    const options = {
      address,
      printerKey: 'fixture',
      httpPort: mock.httpPort,
      mqttPort: mock.mqttPort,
      pinSha256: mock.tls.serverFingerprintSha256,
      reconnectMs: 100,
    }
    await assert.rejects(
      connectKobraX(options),
      /client certificate and key are required/,
    )
    await assert.rejects(
      connectKobraX({
        ...options,
        clientIdentity: { cert: wrong.cert, key: wrong.key },
      }),
      /rejected the client certificate|Check the client certificate/,
    )
    const clientIdentity = {
      cert: mock.tls.clientCert,
      key: mock.tls.clientKey,
    }
    await assert.rejects(
      connectKobraX({ ...options, clientIdentity, pinSha256: '0'.repeat(64) }),
      /fingerprint mismatch/,
    )
    const invalidCtrl = await withInfoServer(t, (req, res) => {
      if (req.url === '/info') {
        res.writeHead(200).end(JSON.stringify(goodInfo))
        return
      }
      res.writeHead(200).end(
        JSON.stringify({
          code: 200,
          data: { token: 'a'.repeat(16), info: 'AA==' },
        }),
      )
    })
    await assert.rejects(
      connectKobraX({ ...options, clientIdentity, httpPort: invalidCtrl.port }),
      /Kobra X credential recovery failed/,
    )
    assert.deepEqual(
      invalidCtrl.paths.map((path) => path.split('?')[0]),
      ['/info', '/ctrl'],
    )
    adapter = await connectKobraX({ ...options, clientIdentity })
    await until(() => adapter.snapshot().materials?.length === 4)
    assert.equal(adapter.snapshot().state, 'idle')
    assert.equal(adapter.snapshot().firmware.current, '2.0.2.8-synthetic')
    assert.equal(adapter.cameraUrl(), mock.flvUrl)
    assert.equal(
      adapter.fingerprint(),
      new X509Certificate(mock.tls.serverCert).fingerprint256
        .replaceAll(':', '')
        .toLowerCase(),
    )
    assert.deepEqual(adapter.snapshot().materials[2], {
      slot: '1-3',
      colorHex: 'FF0000FF',
      active: false,
      remainingPercent: 70,
      materialType: 'PETG',
    })

    mock.control.publishTypedReport('tempature', 'query', {
      curr_nozzle_temp: 210,
      curr_hotbed_temp: 60,
    })
    await until(() => adapter.snapshot().toolTemperatureCelsius === 210)
    assert.equal(adapter.snapshot().bedTemperatureCelsius, 60)

    await mock.control.startPrint('fixture.gcode', { preparationPhases: [] })
    await until(() => adapter.snapshot().state === 'printing')
    mock.control.publishTypedReport(
      'print',
      'start',
      { progress: 40, curr_layer: 20, print_time: 60 },
      { state: 'printing' },
    )
    await until(() => adapter.snapshot().progress === 0.4)
    for (const phase of [
      ...KOBRA_X_PREPARATION_PHASES,
      'ace_filament_unfeeding',
      'nozzle_cooling',
      'hotbed_cooling_off',
      'nozzle_cooling_off',
    ]) {
      const filename = phase + '.gcode'
      mock.control.publishTypedReport(
        'print',
        'start',
        {
          filename,
          progress: 0,
          curr_layer: 0,
          print_time: 0,
        },
        { state: phase },
      )
      await until(() => adapter.snapshot().filename === filename)
      assert.equal(adapter.snapshot().state, 'printing')
      assert.equal(adapter.snapshot().progress, 0.4)
      assert.equal(adapter.snapshot().currentLayer, 20)
      assert.equal(adapter.snapshot().printDuration, 60)
    }
    mock.control.setJobPhase('paused')
    await until(() => adapter.snapshot().state === 'paused')
    mock.control.finishPrint()
    await until(() => adapter.snapshot().lastJob?.outcome === 'completed')
    await mock.control.startPrint('cancel.gcode', { preparationPhases: [] })
    mock.control.setPrintProgress(10)
    await until(() => adapter.snapshot().progress === 0.1)
    mock.control.publishTypedReport(
      'print',
      'stop',
      {},
      { state: 'stoped', code: 200 },
    )
    await until(() => adapter.snapshot().lastJob?.outcome === 'cancelled')
    await mock.control.startPrint('fail.gcode', { preparationPhases: [] })
    mock.control.failPrint(10111, 'fixture error')
    await until(() => adapter.snapshot().lastJob?.outcome === 'failed')
    assert.equal(adapter.snapshot().state, 'error')

    await mock.control.disconnectClients()
    await until(() => adapter.snapshot().state === 'offline')
    await until(() => adapter.snapshot().state === 'idle')
    assert.equal(adapter.cameraUrl(), mock.flvUrl)
  },
)

test('SSDP filters replies before confirming the sender and refuses redirects', async (t) => {
  installNetworkGuard()
  const ssdp = createSocket('udp4')
  const impostor = createSocket('udp4')
  const paths = []
  const http = createServer((req, res) => {
    paths.push(req.url)
    res.writeHead(302, { location: '/redirected' }).end()
  })
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => ssdp.close(resolve)),
      new Promise((resolve) => impostor.close(resolve)),
      new Promise((resolve) => http.close(resolve)),
    ])
    uninstallNetworkGuard()
  })
  ssdp.bind(0, address)
  impostor.bind(0, address)
  http.listen(0, address)
  await Promise.all([
    once(ssdp, 'listening'),
    once(impostor, 'listening'),
    once(http, 'listening'),
  ])
  const options = {
    target: address,
    ssdpPort: ssdp.address().port,
    httpPort: http.address().port,
    timeoutMs: 200,
  }
  ssdp.once('message', (_, sender) => {
    ssdp.send('HTTP/1.1 200 OK', sender.port, sender.address)
    ssdp.send('ac:3dprinter' + 'x'.repeat(2048), sender.port, sender.address)
    impostor.send(Buffer.alloc(0), sender.port, sender.address)
  })
  assert.deepEqual(await discoverKobraX(options), [])
  assert.deepEqual(paths, [])

  ssdp.once('message', (_, sender) => {
    ssdp.send(
      'ac:3dprinter LOCATION: http://192.0.2.1:18910/ignored',
      sender.port,
      sender.address,
    )
  })
  assert.deepEqual(await discoverKobraX(options), [])
  assert.deepEqual(paths, ['/info'])
})

const goodInfo = {
  ctrlType: 'lan',
  modelId: '20030',
  token: 't'.repeat(32),
  deviceName: 'Anycubic Kobra X',
}

async function withInfoServer(t, respond) {
  const paths = []
  const http = createServer((req, res) => {
    paths.push(req.url)
    respond(req, res)
  })
  http.listen(0, address)
  await once(http, 'listening')
  t.after(() => new Promise((resolve) => http.close(resolve)))
  return { paths, port: http.address().port }
}

test('/info must confirm the LAN model before a sender counts as a printer', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const reject = [
    ['another model', { ...goodInfo, modelId: '20029' }],
    ['not LAN mode', { ...goodInfo, ctrlType: 'cloud' }],
    ['short token', { ...goodInfo, token: 'short' }],
    ['numeric token', { ...goodInfo, token: 1 }],
    ['missing model', { ...goodInfo, modelId: undefined }],
  ]
  for (const [label, body] of reject) {
    const { port } = await withInfoServer(t, (_, res) =>
      res.writeHead(200).end(JSON.stringify(body)),
    )
    await assert.rejects(
      readKobraXInfo(address, port),
      /identity could not be confirmed/,
      label,
    )
  }
  const { port, paths } = await withInfoServer(t, (_, res) =>
    res.writeHead(200).end(
      JSON.stringify({
        ...goodInfo,
        deviceName: 'N'.repeat(500),
        ctrlInfoUrl: 'http://192.0.2.7:18910/ctrl',
      }),
    ),
  )
  const info = await readKobraXInfo(address, port)
  assert.equal(info.address, address)
  assert.equal(info.token, goodInfo.token)
  assert.equal(info.name.length, 64)
  assert.deepEqual(paths, ['/info'])
})

test('/info input is bounded and /info errors never leave the LAN', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const oversized = await withInfoServer(t, (_, res) =>
    res
      .writeHead(200)
      .end(JSON.stringify({ ...goodInfo, pad: 'x'.repeat(20000) })),
  )
  await assert.rejects(
    readKobraXInfo(address, oversized.port),
    /exceeded size limit/,
  )
  const garbage = await withInfoServer(t, (_, res) =>
    res.writeHead(200).end('<html>not json'),
  )
  await assert.rejects(readKobraXInfo(address, garbage.port))
  const failing = await withInfoServer(t, (_, res) =>
    res.writeHead(500).end('{}'),
  )
  await assert.rejects(readKobraXInfo(address, failing.port), /request failed/)
  for (const remote of ['192.0.2.1', '8.8.8.8', 'printer.example', '::1']) {
    await assert.rejects(
      readKobraXInfo(remote, 1),
      /requires a local IPv4 address/,
    )
  }
  await assert.rejects(
    discoverKobraX({ target: '8.8.8.8', timeoutMs: 50 }),
    /Invalid SSDP target/,
  )
})

test('SSDP reads at most 64 replies and keeps only a confirmed private sender', async (t) => {
  installNetworkGuard()
  const ssdp = createSocket('udp4')
  const { port: httpPort, paths } = await withInfoServer(t, (_, res) =>
    res.writeHead(200).end(JSON.stringify(goodInfo)),
  )
  ssdp.bind(0, address)
  await once(ssdp, 'listening')
  t.after(async () => {
    await new Promise((resolve) => ssdp.close(resolve))
    uninstallNetworkGuard()
  })
  const options = {
    target: address,
    ssdpPort: ssdp.address().port,
    httpPort,
    timeoutMs: 400,
  }
  // The printer answers with one empty datagram, which is the documented reply.
  ssdp.once('message', (_, sender) =>
    ssdp.send(Buffer.alloc(0), sender.port, sender.address),
  )
  const found = await discoverKobraX(options)
  assert.equal(found.length, 1)
  assert.equal(found[0].address, address)
  assert.equal(found[0].token, goodInfo.token)
  assert.deepEqual(paths, ['/info'])

  // 64 unrelated replies exhaust the budget before the real answer is read.
  paths.length = 0
  ssdp.once('message', (_, sender) => {
    for (let index = 0; index < 64; index++)
      ssdp.send('HTTP/1.1 200 OK', sender.port, sender.address)
    ssdp.send(Buffer.alloc(0), sender.port, sender.address)
  })
  assert.deepEqual(await discoverKobraX(options), [])
  assert.deepEqual(paths, [])
})

function phaseReport(state, data = {}, extra = {}) {
  return { type: 'print', action: 'start', state, data, ...extra }
}

test('documented job phases keep the last progress and map job endings', () => {
  const status = createKobraXStatus('fixture', address)
  assert.equal(status.snapshot().state, 'offline')
  status.report(
    'print',
    phaseReport('printing', {
      filename: 'job.gcode',
      progress: 42,
      curr_layer: 7,
      print_time: 90,
    }),
  )
  const phases = [
    'checking',
    'hotbed_heating',
    'nozzle_heating',
    'ace_filament_unfeeding',
    'ace_filament_feeding',
    'nozzle_purging',
    'nozzle_wiping',
    'nozzle_cooling',
    'auto_leveling',
    'z_offset_calibrating',
    'frequency_sweeping',
    'hotbed_cooling_off',
    'nozzle_cooling_off',
  ]
  for (const phase of phases) {
    status.report(
      'print',
      phaseReport(phase, { progress: 0, curr_layer: 0, print_time: 0 }),
    )
    const snapshot = status.snapshot()
    assert.equal(snapshot.state, 'printing', phase)
    assert.equal(snapshot.progress, 0.42, phase)
    assert.equal(snapshot.currentLayer, 7, phase)
    assert.equal(snapshot.printDuration, 90, phase)
    assert.equal(snapshot.filename, 'job.gcode', phase)
  }

  // Answers meant for another client and unknown phases are not job states.
  status.report(
    'print',
    phaseReport('printing', { progress: 99 }, { action: 'getSliceParam' }),
  )
  status.report('print', phaseReport('some_future_phase', { progress: 99 }))
  assert.equal(status.snapshot().progress, 0.42)
  assert.equal(status.snapshot().state, 'printing')

  // Progress is clamped and non-numeric telemetry is ignored.
  status.report('print', phaseReport('printing', { progress: 250 }))
  assert.equal(status.snapshot().progress, 1)
  status.report(
    'print',
    phaseReport('printing', { progress: -5, curr_layer: 1.5, print_time: 'x' }),
  )
  assert.equal(status.snapshot().progress, 1)
  assert.equal(status.snapshot().currentLayer, 7)
  assert.equal(status.snapshot().printDuration, 90)

  status.report('print', phaseReport('finished'))
  const finished = status.snapshot()
  assert.equal(finished.state, 'idle')
  assert.equal(finished.progress, 1)
  assert.equal(finished.lastJob.outcome, 'completed')
  assert.equal(finished.lastJob.filename, 'job.gcode')
  const endedAt = finished.lastJob.endedAt
  status.report('print', phaseReport('finished'))
  assert.equal(status.snapshot().lastJob.endedAt, endedAt)

  for (const [code, outcome, state] of [
    [200, 'cancelled', 'idle'],
    [0, 'cancelled', 'idle'],
    [10111, 'failed', 'error'],
  ]) {
    status.report('print', phaseReport('printing', { progress: 5 }))
    assert.equal(status.snapshot().lastJob, undefined)
    status.report('print', phaseReport('stoped', {}, { code }))
    assert.equal(status.snapshot().lastJob.outcome, outcome, String(code))
    assert.equal(status.snapshot().state, state, String(code))
  }
  status.report('print', phaseReport('printing', { filename: 'f'.repeat(900) }))
  assert.equal(status.snapshot().filename.length, 128)
})

test('camera URL is handed off only for an unauthenticated HTTP URL on the printer address', () => {
  const status = createKobraXStatus('fixture', address)
  const report = (rtspUrl) =>
    status.report('info', { data: { state: 'free', urls: { rtspUrl } } })
  const flv = `http://${address}:18088/live/${'t'.repeat(32)}`
  report(flv)
  assert.equal(status.cameraUrl(), flv)
  for (const rejected of [
    'http://192.0.2.9:18088/live/x',
    `https://${address}:18088/live/x`,
    `rtsp://${address}:554/live/x`,
    `http://user:pw@${address}:18088/live/x`,
    'not a url',
    42,
  ]) {
    report(rejected)
    assert.equal(status.cameraUrl(), flv, String(rejected))
  }
  status.disconnect()
  assert.equal(status.cameraUrl(), undefined)
  assert.equal(status.snapshot().state, 'offline')
})

test(
  'client certificate problems are reported as missing, invalid or rejected',
  {
    timeout: 20000,
  },
  async (t) => {
    installNetworkGuard()
    const mock = await startKobraXMock({
      strictCtrlQuery: true,
      reportIntervalMs: 0,
    })
    const wrong = generateWrongKobraXClientCert()
    t.after(async () => {
      wrong.cleanup()
      await mock.close()
      uninstallNetworkGuard()
    })
    const options = {
      address,
      printerKey: 'fixture',
      httpPort: mock.httpPort,
      mqttPort: mock.mqttPort,
      pinSha256: mock.tls.serverFingerprintSha256,
      reconnectMs: 100,
    }
    const calls = () => mock.calls()
    const before = calls()
    const missing = /client certificate and key are required/
    await assert.rejects(
      connectKobraX({ ...options, clientIdentity: {} }),
      missing,
    )
    await assert.rejects(
      connectKobraX({
        ...options,
        clientIdentity: { cert: mock.tls.clientCert },
      }),
      missing,
    )
    await assert.rejects(
      connectKobraX({
        ...options,
        clientIdentity: { key: mock.tls.clientKey },
      }),
      missing,
    )
    await assert.rejects(
      connectKobraX({
        ...options,
        clientIdentity: { cert: 'not a certificate', key: 'not a key' },
      }),
      /client certificate or key is invalid/,
    )
    await assert.rejects(
      connectKobraX({
        ...options,
        clientIdentity: { cert: mock.tls.clientCert, key: wrong.key },
      }),
      /client certificate or key is invalid/,
    )
    await assert.rejects(
      connectKobraX({
        ...options,
        clientIdentity: { cert: mock.tls.clientCert, key: mock.tls.clientKey },
        pinSha256: 'not-a-fingerprint',
      }),
      /Invalid Kobra X certificate fingerprint/,
    )
    // Missing and invalid material is refused locally, before any network use.
    assert.deepEqual(calls(), before)

    // A well-formed certificate the printer does not trust is a printer-side rejection.
    await assert.rejects(
      connectKobraX({
        ...options,
        clientIdentity: { cert: wrong.cert, key: wrong.key },
      }),
      /rejected the client certificate|Check the client certificate/,
    )
    assert.ok(
      (calls().TLS_CLIENT_ERROR ?? 0) + (calls().TLS_CLIENT_AUTH_FAILED ?? 0) >=
        1,
    )
  },
)

test('native /ctrl matches the owner vectors and rejects invalid responses', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const token = 'abcdefghijklmnopqrstuvwxyz012345'
  const iv = 'fedcba9876543210'
  const ciphertext =
    'MVKiXl3ql2/w4yj4fxCdaHwbtBLzgliMf3qIt1xiq2lolTgXVSm9OEh0ARykh/VrVUYJJBS4ppKEwweZlT3kdD57+5kos/UXv1gKXdzKMcUosUfyPmRJKctigF/mSO090xxCV+wccHrFoUY5o75h+WuLvOj2hwktsQQndzbtqOcwgu8dn+IWxJWThQi0bsDVJZ8WYVG3CLEC2HLZHs36Mw=='
  assert.equal(
    kobraXCtrlQuery(token, '1700000000000', 'AbC123').toString(),
    'ts=1700000000000&nonce=AbC123&sign=aea435b5fbd0d0731ac51b4510e8c163&did=random',
  )
  const credentials = {
    username: 'user_demo',
    password: 'pass_demo',
    deviceId: '0123456789abcdef0123456789abcdef',
    modeId: '20030',
  }
  const valid = { code: 200, data: { token: iv, info: ciphertext } }
  let status = 200
  let response = valid
  let observed
  const { port } = await withInfoServer(t, (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      observed = {
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks),
        connection: req.headers.connection,
      }
      res.writeHead(status).end(JSON.stringify(response))
    })
  })
  const info = { address, token, name: 'fixture' }
  const started = Date.now()
  assert.deepEqual(await recoverKobraXCredentials(info, port), credentials)
  const url = new URL(observed.url, 'http://127.0.0.1')
  const { ts, nonce, sign, did } = Object.fromEntries(url.searchParams)
  assert.equal(url.pathname, '/ctrl')
  assert.equal(observed.method, 'POST')
  assert.equal(observed.connection, 'close')
  assert.equal(observed.body.length, 0)
  assert.match(ts, /^\d{13}$/)
  assert.ok(Number(ts) >= started && Number(ts) <= Date.now())
  assert.match(nonce, /^[A-Za-z0-9]{6}$/)
  assert.equal(did, 'random')
  assert.equal(
    sign,
    createHash('md5')
      .update('1d64dce239c4437b7736041db089e1b9' + ts + nonce)
      .digest('hex'),
  )

  function encrypt(payload) {
    const cipher = createCipheriv('aes-128-cbc', 'qrstuvwxyz012345', iv)
    return Buffer.concat([cipher.update(payload), cipher.final()]).toString(
      'base64',
    )
  }
  function envelope(payload) {
    return { code: 200, data: { token: iv, info: encrypt(payload) } }
  }
  response = envelope(JSON.stringify({ ...credentials, modeId: undefined }))
  assert.deepEqual(await recoverKobraXCredentials(info, port), credentials)

  const badPadding = Buffer.from(ciphertext, 'base64')
  badPadding[badPadding.length - 17] ^= 0xff
  for (const invalid of [
    { ...valid, code: 403 },
    { ...valid, data: { ...valid.data, token: 'é'.repeat(16) } },
    { ...valid, data: { ...valid.data, info: ciphertext + '!' } },
    { ...valid, data: { ...valid.data, info: 'AA==' } },
    { ...valid, data: { ...valid.data, info: badPadding.toString('base64') } },
    envelope(Buffer.from([0xff])),
    envelope('invalid JSON'),
    envelope(JSON.stringify({ ...credentials, error: 'refused' })),
    envelope(JSON.stringify({ ...credentials, password: '' })),
    envelope(JSON.stringify({ ...credentials, deviceId: '+/#' })),
  ]) {
    response = invalid
    await assert.rejects(
      recoverKobraXCredentials(info, port),
      /^Error: Kobra X credential recovery failed$/,
    )
  }
  response = valid
  status = 403
  await assert.rejects(
    recoverKobraXCredentials(info, port),
    /credential recovery failed/,
  )
})
