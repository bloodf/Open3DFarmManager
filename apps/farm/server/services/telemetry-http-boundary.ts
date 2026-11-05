import { IncomingMessage } from 'node:http'

const paths = new Set([
  '/api/connector/telemetry',
  '/api/connector/telemetry/challenge',
])
const singleton = new Set([
  'authorization',
  'content-type',
  'content-length',
  'transfer-encoding',
  'x-connector-agent',
  'x-connector-farm',
  'x-telemetry-challenge',
  'x-telemetry-signature',
])

/** Nitro's Node adapter currently retains its original h3 event as ~app. */
export function telemetryNodeRequest(event: unknown): IncomingMessage {
  if (!event || typeof event !== 'object' || !('~app' in event))
    throw new Error('Unsupported runtime')
  const app = event['~app']
  if (!app || typeof app !== 'object' || !('node' in app))
    throw new Error('Unsupported runtime')
  const node = app.node
  if (
    !node ||
    typeof node !== 'object' ||
    !('req' in node) ||
    !(node.req instanceof IncomingMessage)
  )
    throw new Error('Unsupported runtime')
  return node.req
}

/** Inspect Node's uncombined headers and original request target before reading. */
export function inspectTelemetryRequest(
  req: IncomingMessage,
): Map<string, string> {
  const original =
    'originalUrl' in req && typeof req.originalUrl === 'string'
      ? req.originalUrl
      : req.url
  if (req.method !== 'POST' || !original || !paths.has(original))
    throw new Error('Invalid request')
  if (req.rawHeaders.length > 64) throw new Error('Invalid request')
  let headerBytes = 0
  const headers = new Map<string, string>()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]?.toLowerCase(),
      value = req.rawHeaders[i + 1]
    if (!name || value === undefined) throw new Error('Invalid request')
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value)
    if (headerBytes > 16384) throw new Error('Invalid request')
    if (name === 'cookie' || name === 'origin' || name === 'content-encoding')
      throw new Error('Invalid request')
    if (singleton.has(name)) {
      if (headers.has(name) || value.includes(','))
        throw new Error('Invalid request')
      headers.set(name, value)
    }
  }
  if (headers.get('content-type') !== 'application/json')
    throw new Error('Invalid request')
  const length = headers.get('content-length')
  if (
    length !== undefined &&
    (!/^(0|[1-9]\d*)$/.test(length) ||
      Number(length) < 1 ||
      Number(length) > 65536)
  )
    throw new Error('Invalid request')
  if (length !== undefined && headers.has('transfer-encoding'))
    throw new Error('Invalid request')
  if (
    headers.has('transfer-encoding') &&
    headers.get('transfer-encoding')?.toLowerCase() !== 'chunked'
  )
    throw new Error('Invalid request')
  return headers
}

/** A single bounded Node stream read; caller must acquire admission before invoking. */
export function readTelemetryBytes(
  req: IncomingMessage,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000 ||
    req.readableEnded ||
    req.destroyed ||
    req.readableFlowing !== null
  )
    return Promise.reject(new Error('Invalid request'))
  return new Promise((resolve, reject) => {
    const data = Buffer.allocUnsafe(65536)
    let size = 0,
      finished = false
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('aborted', onAbort)
      req.off('error', onAbort)
    }
    const fail = () => {
      if (finished) return
      finished = true
      cleanup()
      req.destroy()
      reject(new Error('Invalid request'))
    }
    const onData = (chunk: Buffer) => {
      if (!Buffer.isBuffer(chunk) || size + chunk.length > data.length)
        return fail()
      chunk.copy(data, size)
      size += chunk.length
    }
    const onEnd = () => {
      if (finished) return
      if (!size) return fail()
      finished = true
      cleanup()
      resolve(data.subarray(0, size))
    }
    const onAbort = () => fail()
    const timer = setTimeout(fail, timeoutMs)
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('aborted', onAbort)
    req.once('error', onAbort)
  })
}
