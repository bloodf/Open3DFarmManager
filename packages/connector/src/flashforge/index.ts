import { randomUUID } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { request } from 'node:http'
import { isIPv4 } from 'node:net'

// https://github.com/Parallel-7/flashforge-api-docs/wiki/Printer-PIDs
function model(pid: unknown) {
  switch (pid) {
    case 35:
    case '0023':
      return 'Adventurer 5M'
    case 36:
    case '0024':
      return 'Adventurer 5M Pro'
    case 38:
    case '0026':
      return 'AD5X'
    default:
      throw new Error('Unsupported Flashforge model')
  }
}

type Endpoint = { host: string; port?: number; timeoutMs?: number }

function endpoint({ host, port = 8898, timeoutMs = 3000 }: Endpoint) {
  if (
    !isIPv4(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  ) {
    throw new Error('Invalid Flashforge endpoint')
  }
  return { host, port, timeoutMs }
}

// https://github.com/Parallel-7/flashforge-api-docs/wiki/Discovery-Protocol
export function discoverFlashforge(input: Endpoint) {
  const { host, port, timeoutMs } = endpoint({
    ...input,
    port: input.port ?? 48899,
  })
  return new Promise<{ model: ReturnType<typeof model>; serialNumber: string }>(
    (resolve, reject) => {
      const socket = createSocket('udp4')
      const timer = setTimeout(
        () => finish(new Error('Flashforge discovery timeout')),
        timeoutMs,
      )
      function finish(error: Error) {
        clearTimeout(timer)
        socket.close()
        reject(error)
      }
      socket.once('error', finish)
      socket.on('message', (data, sender) => {
        if (sender.address !== host || sender.port !== port) return
        try {
          if (
            data.length < 276 ||
            data.readUInt16BE(0x86) !== 0x2b71 ||
            data.readUInt16BE(0x8e) !== 8898 ||
            data[0x90] !== 0
          ) {
            throw new Error('Invalid Flashforge LAN discovery reply')
          }
          const serialNumber =
            data.subarray(0x92, 0x112).toString().split('\0')[0] ?? ''
          if (!validCredential(serialNumber))
            throw new Error('Invalid Flashforge serial number')
          const verifiedModel = model(data.readUInt16BE(0x88))
          clearTimeout(timer)
          socket.close()
          resolve({ model: verifiedModel, serialNumber })
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new Error('Invalid Flashforge discovery reply'),
          )
        }
      })
      socket.send(Buffer.from([0]), port, host)
    },
  )
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value }
  }
  throw new Error('Malformed Flashforge object')
}

const validCredential = (value: string) => /^[a-zA-Z0-9-]{1,128}$/.test(value)
const reading = (value: unknown, min = 0, max = Infinity) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max
    ? value
    : undefined
const label = (value: unknown) =>
  typeof value === 'string' &&
  value.length <= 256 &&
  !/[\x00-\x1f\x7f]/.test(value) &&
  value !== ''
    ? value
    : undefined

const states = [
  'ready',
  'busy',
  'heating',
  'printing',
  'pausing',
  'pause',
  'canceling',
  'cancel',
  'completed',
  'calibrate_doing',
  'downloading',
  'cloud_slicing',
  'sending',
  'unzipping',
  'error',
  'loading',
]

type Mutation =
  | { kind: 'pause' | 'resume' | 'cancel' }
  | { kind: 'start'; filename: string }
  | { kind: 'upload'; filename: string; content: Uint8Array }
  | { kind: 'temperature'; heater: 'nozzle' | 'bed'; celsius: number }
  | { kind: 'fan'; percent: number }

// The caller owns signed authorization, material limits and the start interlock.
// Recheck that authority and the fresh observation immediately before each write.
export function createFlashforgeAdapter(
  input: Endpoint & {
    serialNumber: string
    checkCode: string
    cameraPort?: number
  },
) {
  const { host, port, timeoutMs } = endpoint(input)
  const { serialNumber, checkCode } = input
  const { port: cameraPort } = endpoint({
    host,
    port: input.cameraPort ?? 8080,
  })
  if (!validCredential(serialNumber) || !validCredential(checkCode)) {
    throw new Error('Invalid Flashforge credentials')
  }

  // https://github.com/Parallel-7/flashforge-api-docs/wiki/HTTP-REST-API
  async function post(
    path: string,
    fields: object = {},
    upload?: { body: Buffer; headers: Record<string, string> },
  ) {
    const body =
      upload?.body ??
      Buffer.from(JSON.stringify({ serialNumber, checkCode, ...fields }))
    const raw = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host,
          port,
          path,
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            ...upload?.headers,
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            req.destroy(new Error(`Flashforge HTTP ${res.statusCode}`))
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > 1024 * 1024)
              req.destroy(new Error('Oversized Flashforge reply'))
            else chunks.push(chunk)
          })
          res.once('error', reject)
          res.once('end', () => resolve(Buffer.concat(chunks).toString()))
        },
      )
      const timer = setTimeout(
        () => req.destroy(new Error('Flashforge request timeout')),
        timeoutMs,
      )
      req.once('error', reject)
      req.once('close', () => clearTimeout(timer))
      req.end(body)
    })
    let reply: Record<string, unknown>
    try {
      reply = object(JSON.parse(raw))
    } catch {
      throw new Error('Malformed Flashforge reply')
    }
    if (!Number.isSafeInteger(reply.code))
      throw new Error('Malformed Flashforge result code')
    if (reply.code !== 0)
      throw new Error(`Flashforge rejected request (code ${reply.code})`)
    return reply
  }

  async function readStatus() {
    const detail = object((await post('/detail')).detail)
    const printerModel = model(detail.pid)
    const firmware = label(detail.firmwareVersion)?.replace(/^v/i, '')
    const supported =
      printerModel === 'AD5X' ? ['1.1.7', '1.2.1', '3.1.0'] : ['3.2.7', '5.1.8']
    if (!firmware || !supported.includes(firmware))
      throw new Error('Unsupported Flashforge firmware')
    const status = label(detail.status)
    if (!status || !states.includes(status))
      throw new Error('Unsupported Flashforge state')
    let cameraUrl: string | undefined
    if (label(detail.cameraStreamUrl)) {
      const url = URL.parse(String(detail.cameraStreamUrl))
      if (
        url?.origin === `http://${host}:8080` &&
        url.pathname === '/' &&
        url.search === '?action=stream' &&
        !url.username &&
        !url.password &&
        !url.hash
      ) {
        cameraUrl = url.href
      }
    }
    const station =
      printerModel === 'AD5X' && detail.hasMatlStation === true
        ? object(detail.matlStationInfo)
        : undefined
    const slots =
      station && Array.isArray(station.slotInfos)
        ? station.slotInfos.map((entry: unknown) => {
            const slot = object(entry)
            const id = reading(slot.slotId, 0, 3)
            if (
              id === undefined ||
              !Number.isInteger(id) ||
              typeof slot.hasFilament !== 'boolean'
            ) {
              throw new Error('Malformed Flashforge material slot')
            }
            return {
              id,
              loaded: slot.hasFilament,
              material: label(slot.materialName),
              color: label(slot.materialColor),
            }
          })
        : undefined
    return {
      model: printerModel,
      firmware,
      status,
      cameraUrl,
      slots,
      filename: label(detail.printFileName),
      progress: reading(detail.printProgress, 0, 1),
      nozzle: {
        current: reading(detail.rightTemp),
        target: reading(detail.rightTargetTemp),
      },
      bed: {
        current: reading(detail.platTemp),
        target: reading(detail.platTargetTemp),
      },
      coolingFanPercent: reading(detail.coolingFanSpeed, 0, 100),
      filtration:
        printerModel === 'Adventurer 5M Pro'
          ? {
              internal: fanState(detail.internalFanStatus),
              external: fanState(detail.externalFanStatus),
            }
          : undefined,
      material: label(detail.rightFilamentType),
      estimatedGrams: reading(detail.estimatedRightWeight),
      errorCode: label(detail.errorCode),
    }
  }

  async function openCamera(signal: AbortSignal) {
    signal.throwIfAborted()
    const { cameraUrl } = await readStatus()
    if (!cameraUrl) throw new Error('Flashforge camera unavailable')
    const url = new URL(cameraUrl)
    url.port = String(cameraPort)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const reply = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.any([signal, controller.signal]),
      })
      const contentType = reply.headers.get('content-type')
      if (
        reply.status !== 200 ||
        !reply.body ||
        !contentType ||
        !/^multipart\/x-mixed-replace\s*;\s*boundary=.+$/i.test(contentType)
      ) {
        controller.abort()
        throw new Error('Invalid Flashforge camera response')
      }
      return { contentType, body: reply.body }
    } finally {
      clearTimeout(timer)
    }
  }

  async function listFiles() {
    const { model: printerModel } = await readStatus()
    const reply = await post('/gcodeList')
    const ad5x = printerModel === 'AD5X'
    const files = ad5x ? reply.gcodeListDetail : reply.gcodeList
    if (!Array.isArray(files)) throw new Error('Malformed Flashforge file list')
    return files.map((entry: unknown) => {
      const filename = label(ad5x ? object(entry).gcodeFileName : entry)
      if (!filename) throw new Error('Malformed Flashforge filename')
      return filename
    })
  }

  function fanState(value: unknown) {
    return value === 'open' || value === 'close' ? value : undefined
  }

  let writing = false
  async function execute(
    action: Mutation,
    authorize: (observation: Awaited<ReturnType<typeof readStatus>>) => boolean,
  ) {
    if (writing) throw new Error('Flashforge write already in progress')
    writing = true
    try {
      const observation = await readStatus()
      const { status } = observation
      if (observation.model === 'AD5X')
        throw new Error('Flashforge writes unavailable on AD5X')
      const allowed = () => {
        if (authorize(observation) !== true)
          throw new Error('Flashforge action denied')
      }
      const control = async (cmd: string, args: object) => {
        allowed()
        await post('/control', { payload: { cmd, args } })
      }
      switch (action.kind) {
        case 'pause':
        case 'resume':
        case 'cancel': {
          const active =
            action.kind === 'pause'
              ? status === 'printing'
              : action.kind === 'resume'
                ? status === 'pause'
                : ['printing', 'pause', 'heating'].includes(status)
          if (!active || !observation.filename)
            throw new Error('Flashforge job state denied')
          await control('jobCtl_cmd', {
            jobID: '',
            action: action.kind === 'resume' ? 'continue' : action.kind,
          })
          break
        }
        case 'temperature': {
          // https://en.fss.flashforge.com/10000/software/2a9ce576d4dc68efa85e202d82bff905.pdf
          if (
            (action.heater !== 'nozzle' && action.heater !== 'bed') ||
            !Number.isInteger(action.celsius) ||
            action.celsius < 0 ||
            action.celsius > (action.heater === 'nozzle' ? 280 : 110) ||
            !['ready', 'printing', 'pause'].includes(status)
          ) {
            throw new Error('Flashforge temperature denied')
          }
          await control('temperatureCtl_cmd', {
            [action.heater === 'nozzle' ? 'rightNozzle' : 'platform']:
              action.celsius || -100,
          })
          break
        }
        case 'fan':
          if (
            status !== 'printing' ||
            !Number.isInteger(action.percent) ||
            action.percent < 0 ||
            action.percent > 100
          ) {
            throw new Error('Flashforge fan action denied')
          }
          await control('printerCtl_cmd', { coolingFan: action.percent })
          break
        case 'start':
        case 'upload': {
          if (
            status !== 'ready' ||
            !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}\.gcode$/.test(action.filename)
          ) {
            throw new Error('Flashforge file action denied')
          }
          if (action.kind === 'start') {
            allowed()
            await post('/printGcode', {
              fileName: action.filename,
              levelingBeforePrint: true,
            })
            break
          }
          if (
            !action.content.length ||
            action.content.length > 32 * 1024 * 1024
          ) {
            throw new Error('Invalid Flashforge upload size')
          }
          const boundary = randomUUID()
          const body = Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="gcodeFile"; filename="${action.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
            ),
            action.content,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ])
          allowed()
          await post(
            '/uploadGcode',
            {},
            {
              body,
              headers: {
                'content-type': `multipart/form-data; boundary=${boundary}`,
                serialNumber,
                checkCode,
                fileSize: String(action.content.length),
                printNow: 'false',
                levelingBeforePrint: 'true',
              },
            },
          )
          break
        }
        default:
          throw new Error('Unsupported Flashforge action')
      }
      return { acknowledged: true }
    } finally {
      writing = false
    }
  }
  return { readStatus, listFiles, openCamera, execute }
}
