import { execFileSync } from 'node:child_process'
import { createCipheriv, createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMqttBroker, type MqttMessage } from './mocks/mqtt-broker.ts'
import { getSharedThrowawayTls } from './mocks/tls.ts'

export async function startPhotonHandshakeSimulator({
  identity,
  credentials,
  fault,
}: {
  identity: Record<string, unknown> & { token: string }
  credentials: Record<string, unknown>
  fault?: 'deny' | 'disconnect' | 'timeout' | 'malformed' | 'bad-ciphertext'
}) {
  let exchanges = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/info' && request.method === 'GET') {
      response.end(JSON.stringify(identity))
      return
    }
    if (url.pathname !== '/ctrl' || request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    exchanges++
    const ts = url.searchParams.get('ts') ?? ''
    const nonce = url.searchParams.get('nonce') ?? ''
    const keyDigest = createHash('md5')
      .update(identity.token.slice(0, 16))
      .digest('hex')
    const expected = createHash('md5')
      .update(keyDigest)
      .update(ts)
      .update(nonce)
      .digest('hex')
    if (
      fault === 'deny' ||
      !/^\d{13}$/.test(ts) ||
      !/^[a-f0-9]{16}$/.test(nonce) ||
      !url.searchParams.get('did') ||
      url.searchParams.get('sign') !== expected
    ) {
      response.end(JSON.stringify({ code: 19002 }))
      return
    }
    if (fault === 'timeout') return
    if (fault === 'disconnect') {
      request.socket.destroy()
      return
    }
    if (fault === 'malformed') {
      response.end('{')
      return
    }
    const iv = 'fixture-only-iv!'
    const cipher = createCipheriv('aes-128-cbc', identity.token.slice(16), iv)
    cipher.setAutoPadding(false)
    const plain = Buffer.from(JSON.stringify(credentials))
    const padded = Buffer.concat([
      plain,
      Buffer.alloc((16 - (plain.length % 16)) % 16),
    ])
    const info = Buffer.concat([
      cipher.update(padded),
      cipher.final(),
    ]).toString('base64')
    response.end(
      JSON.stringify({
        code: 200,
        data: { info: fault === 'bad-ciphertext' ? 'AAAA' : info, token: iv },
      }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing loopback address')
  return {
    host: address.address,
    port: address.port,
    exchanges: () => exchanges,
    async close() {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    },
  }
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing loopback address')
  return address.port
}

// The real broker presents RSA 1024 with SHA-1.
// https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/docs/protocol.md#tls-configuration
function weakTls() {
  const directory = mkdtempSync(join(tmpdir(), 'photon-weak-tls-'))
  try {
    const key = join(directory, 'key.pem')
    const cert = join(directory, 'cert.pem')
    execFileSync(
      'openssl',
      [
        ...['req', '-x509', '-newkey', 'rsa:1024', '-sha1', '-nodes'],
        ...['-keyout', key, '-out', cert, '-days', '1'],
        ...['-subj', '/O=Synthetic Photon fixture'],
      ],
      { stdio: 'ignore', timeout: 30_000 },
    )
    return { key: readFileSync(key), cert: readFileSync(cert) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

type PhotonJob = {
  taskid: string
  filename: string
  state: 'printing' | 'waiting'
  code: number
  progress: number
  layer: number
}

/** Synthetic FLV: the header, then one placeholder video tag per frame. */
const flvHeader = Buffer.from([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9])
const flvVideoTag = Buffer.from([
  ...[9, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
  0x17,
  ...[0, 0, 0, 12],
])

/**
 * Synthetic Photon P1 Max in LAN Mode. Report shapes follow the public captures
 * cited in packages/connector/src/anycubic-resin/models.ts. Values the captures
 * omit (the `busy` status, copy timing, which requests fail silently) are
 * made up. It is not hardware evidence.
 */
export async function startPhotonP1MaxSimulator({
  identity,
  credentials,
  usbFiles = ['TEST.pp1m'],
  vatEmpty = false,
  usbDisk = true,
  camera = true,
  weakCertificate = false,
  liveStream = false,
}: {
  identity: Record<string, unknown> & { token: string }
  credentials: Record<string, unknown> & {
    deviceId: string
    clientId: string
    username: string
    password: string
  }
  usbFiles?: string[]
  /** The captured stall: the job waits with code 1301. */
  vatEmpty?: boolean
  usbDisk?: boolean
  camera?: boolean
  weakCertificate?: boolean
  /** Keep `/flv` open and send synthetic tags until capture stops. */
  liveStream?: boolean
}) {
  const root = 'anycubic/anycubicCloud/v1'
  const reports = `${root}/printer/public/132/${credentials.deviceId}/`
  const requests = `${root}/web/printer/132/${credentials.deviceId}/`
  const state = {
    job: null as PhotonJob | null,
    cameraStreaming: false,
    resinTemperatureC: 24.389999,
    releaseFilm: { times: 12, layers: 3456, status: 0 },
  }
  const received: string[] = []
  /** The printer drops these: nothing changes and nothing is reported. */
  const ignored = new Set<string>()
  /** The printer applies these, but their report never arrives. */
  const unreported = new Set<string>()

  const tls = weakCertificate ? weakTls() : getSharedThrowawayTls().server
  const handshake = await startPhotonHandshakeSimulator({
    identity,
    credentials,
  })
  const video = createServer((request, response) => {
    if (request.url !== '/flv') {
      response.end('ok')
      return
    }
    // `ok` when idle, FLV bytes while capturing (protocol notes above).
    if (!state.cameraStreaming || !liveStream) {
      response.end(state.cameraStreaming ? flvHeader : 'ok')
      return
    }
    response.writeHead(200, { 'content-type': 'video/x-flv' })
    response.write(Buffer.concat([flvHeader, Buffer.alloc(4)]))
    const frames = setInterval(() => {
      if (state.cameraStreaming) response.write(flvVideoTag)
      else response.end()
    }, 100)
    response.on('close', () => clearInterval(frames))
  })
  const cameraPort = await listen(video)

  function publish(
    type: string,
    action: string,
    reportState: string,
    data: unknown,
    { code = 200, msgid = '' } = {},
  ) {
    broker.control.publish(`${reports}${type}/report`, {
      type,
      action,
      msgid,
      state: reportState,
      timestamp: Date.now(),
      code,
      msg: '',
      data,
    })
  }

  const jobData = (job: PhotonJob) => ({
    taskid: job.taskid,
    filename: job.filename,
    progress: job.progress,
    curr_layer: job.layer,
    total_layers: 697,
    // Present at layer 0: the whole job's estimate.
    supplies_usage: 25.17914,
    remain_time: 115,
    print_time: 0,
  })

  function handle(message: MqttMessage) {
    if (!message.topic.startsWith(requests)) return
    const request = JSON.parse(message.payload.toString('utf8'))
    const type = message.topic.slice(requests.length)
    // The P1 Max ignores requests without a timestamp and msgid.
    if (
      request.type !== type ||
      !Number.isInteger(request.timestamp) ||
      typeof request.msgid !== 'string'
    )
      return
    const operation = `${type}/${request.action}`
    received.push(operation)
    if (ignored.has(operation)) return
    const data = request.data ?? {}
    const report = (
      reportType: string,
      action: string,
      reportState: string,
      body: unknown,
      code = 200,
    ) => {
      if (!unreported.has(operation))
        publish(reportType, action, reportState, body, {
          code,
          msgid: request.msgid,
        })
    }

    if (operation === 'status/query') {
      report('status', 'workReport', state.job ? 'busy' : 'free', null)
    } else if (operation === 'print/query') {
      if (!state.job) return
      report(
        'print',
        'start',
        state.job.state,
        jobData(state.job),
        state.job.code,
      )
    } else if (operation === 'peripherie/query') {
      report('peripherie', 'query', 'done', {
        camera: Number(camera),
        udisk: Number(usbDisk),
        smartResinVat: 1,
        airpure: 0,
      })
    } else if (operation === 'releaseFilm/get') {
      report('releaseFilm', 'get', 'done', { ...state.releaseFilm }, 0)
    } else if (operation === 'file/listLocal') {
      if (data.path !== '/') return
      report('file', 'listLocal', 'done', {
        list_mode: 0,
        records: [
          { is_dir: true, filename: 'cloud', timestamp: 1, size: 4096 },
        ],
      })
    } else if (
      operation === 'video/startCapture' ||
      operation === 'video/stopCapture'
    ) {
      state.cameraStreaming = request.action === 'startCapture'
      report(
        'video',
        request.action,
        state.cameraStreaming ? 'initSuccess' : 'done',
        null,
      )
    } else if (operation === 'print/start') {
      if (
        state.job ||
        !usbDisk ||
        data.taskid !== '-1' ||
        data.filetype !== 2 ||
        data.filepath !== '/' ||
        !usbFiles.includes(data.filename)
      )
        return
      state.job = {
        taskid: '0',
        filename: data.filename,
        state: vatEmpty ? 'waiting' : 'printing',
        code: vatEmpty ? 1301 : 200,
        progress: 0,
        layer: 0,
      }
      report('print', 'start', 'copying', { taskid: '-1', progress: 50 })
      report(
        'print',
        'start',
        state.job.state,
        jobData(state.job),
        state.job.code,
      )
    } else if (operation === 'print/pause') {
      report('print', 'pause', 'unablePause', { taskid: '0' }, 9000)
    } else if (operation === 'print/resume') {
      report('print', 'resume', 'unable-resume', { taskid: '' }, 102)
    } else if (operation === 'print/stop') {
      const job = state.job
      if (!job || data.taskid !== job.taskid) return
      state.job = null
      report('print', 'stop', 'stoped', jobData(job), 601)
    }
  }

  function pushResinTemperature() {
    publish('properties', 'report', 'done', {
      resin_temp: state.resinTemperatureC,
    })
  }

  const broker = await startMqttBroker({
    tls,
    ...(weakCertificate ? { ciphers: 'DEFAULT:@SECLEVEL=0' } : {}),
    auth: {
      clientId: credentials.clientId,
      username: credentials.username,
      password: credentials.password,
    },
    // The P1 Max refuses `#` and grants one report level.
    authorizeSubscribe: (topic) => topic === `${reports}+/report`,
    onSubscribe: () => pushResinTemperature(),
    onPublish: handle,
  })

  return {
    host: handshake.host,
    port: handshake.port,
    brokerPort: broker.ports.mqtt,
    cameraPort,
    pinSha256: createHash('sha256')
      .update(new X509Certificate(tls.cert).raw)
      .digest('hex'),
    exchanges: handshake.exchanges,
    brokerCalls: () => broker.calls(),
    faults: broker.control.faults,
    printer: () => structuredClone(state),
    received: () => [...received],
    ignored,
    unreported,
    publish,
    reportTopic: (type: string) => `${reports}${type}/report`,
    publishRaw: broker.control.publish,
    setResinTemperature(celsius: number) {
      state.resinTemperatureC = celsius
      pushResinTemperature()
    },
    disconnect: broker.control.disconnectClients,
    /** A job started at the printer, outside the LAN client. */
    startJob(filename: string, progress = 0, layer = 0) {
      state.job = {
        taskid: '0',
        filename,
        state: 'printing',
        code: 200,
        progress,
        layer,
      }
    },
    async close() {
      const closed = once(video, 'close')
      video.close()
      video.closeAllConnections()
      await Promise.all([closed, broker.close(), handshake.close()])
    },
  }
}
