import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

// Contracts: https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml
// API-key auth and upload: PrusaSlicer, PrintHostPrusaLink.cpp (see docs/protocols/prusa.md).
// Connect Local: https://github.com/prusa3d/prusa-connect/tree/main/docs/src/content/docs/reference/api
type Guard = { beforeSend(): boolean; signal?: AbortSignal }

export class PrusaHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Prusa HTTP ${status}`)
    this.status = status
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed Prusa response')
  return value as Record<string, unknown>
}

function segment(value: string) {
  if (!value || value === '.' || value === '..' || /[/\\\x00-\x1f]/.test(value))
    throw new Error('Invalid Prusa path segment')
  return encodeURIComponent(value)
}

function transport(
  endpoint: string,
  auth: Record<string, string>,
  timeoutMs: number,
) {
  const origin = new URL(endpoint)
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Invalid Prusa endpoint')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error('Invalid Prusa timeout')

  return function request(
    path: string,
    expected: number[],
    init: RequestInit = {},
    guard?: Guard,
  ) {
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = guard?.signal
      ? AbortSignal.any([deadline, guard.signal])
      : deadline
    const headers = new Headers({ ...auth, Accept: 'application/json' })
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    if (init.method) {
      const target = new URL(path, origin)
      const send = origin.protocol === 'https:' ? httpsRequest : httpRequest
      const body = init.body as Uint8Array | undefined
      if (body) headers.set('Content-Length', String(body.byteLength))
      signal.throwIfAborted()
      if (!guard?.beforeSend()) throw new Error('Prusa send denied')
      return new Promise<Response>((resolve, reject) => {
        // A fresh connection and one request, including for idempotent HTTP verbs.
        const mutation = send(
          target,
          {
            method: init.method,
            agent: false,
            signal,
            headers: Object.fromEntries(headers),
          },
          (response) => {
            response.on('error', reject)
            response.on('end', () => {
              const status = response.statusCode ?? 0
              if (expected.includes(status))
                resolve(new Response(null, { status }))
              else reject(new PrusaHttpError(status))
            })
            response.resume()
          },
        )
        mutation.on('error', reject)
        mutation.end(body)
      })
    }
    signal.throwIfAborted()
    return fetch(new URL(path, origin), {
      ...init,
      signal,
      headers,
      redirect: 'manual',
    }).then(async (response) => {
      if (!expected.includes(response.status)) {
        await response.body?.cancel()
        throw new PrusaHttpError(response.status)
      }
      return response
    })
  }
}

async function json(response: Response) {
  return record(await response.json())
}

async function snapshot(response: Response) {
  if (response.status === 204) return null
  const contentType = response.headers.get('content-type')?.split(';')[0]
  if (contentType !== 'image/png' && contentType !== 'image/jpeg') {
    await response.body?.cancel()
    throw new Error('Malformed Prusa camera response')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const signature =
    contentType === 'image/png'
      ? [137, 80, 78, 71, 13, 10, 26, 10]
      : [255, 216, 255]
  if (!signature.every((byte, index) => bytes[index] === byte))
    throw new Error('Malformed Prusa camera image')
  return { contentType, bytes }
}

export function createPrusaLink(
  endpoint: string,
  apiKey: string,
  timeoutMs = 5000,
) {
  if (!apiKey.trim()) throw new Error('PrusaLink API key required')
  const request = transport(endpoint, { 'X-Api-Key': apiKey }, timeoutMs)
  const file = (storage: string, filename: string) =>
    `/api/v1/files/${segment(storage)}/${segment(filename)}`
  return {
    async discover() {
      const version = await json(await request('/api/version', [200]))
      if (typeof version.api !== 'string' || !/^1\./.test(version.api))
        throw new Error('Unsupported PrusaLink API version')
      const info = await json(await request('/api/v1/info', [200]))
      return { version, info }
    },
    async status() {
      const status = await json(await request('/api/v1/status', [200]))
      const printer = record(status.printer)
      if (typeof printer.state !== 'string' || !printer.state)
        throw new Error('Malformed Prusa printer state')
      for (const key of [
        'temp_nozzle',
        'target_nozzle',
        'temp_bed',
        'target_bed',
        'fan_hotend',
        'fan_print',
      ]) {
        if (key in printer && !Number.isFinite(printer[key]))
          throw new Error('Malformed Prusa printer telemetry')
      }
      const job = status.job === undefined ? undefined : record(status.job)
      if (
        job &&
        'id' in job &&
        (!Number.isSafeInteger(job.id) || Number(job.id) < 0)
      )
        throw new Error('Malformed Prusa job ID')
      return { ...status, printer, job }
    },
    async camera() {
      const response = await request('/api/v1/cameras/snap', [200, 204])
      return snapshot(response)
    },
    async upload(
      storage: string,
      filename: string,
      bytes: Uint8Array<ArrayBuffer>,
      guard: Guard,
    ) {
      if (!bytes.length) throw new Error('Empty Prusa upload')
      // Older Link versions could treat the presence of Print-After-Upload as true.
      await request(
        file(storage, filename),
        [201],
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            Overwrite: '?0',
          },
          body: bytes,
        },
        guard,
      )
    },
    async start(storage: string, filename: string, guard: Guard) {
      await request(file(storage, filename), [204], { method: 'POST' }, guard)
    },
    async control(
      jobId: number,
      action: 'pause' | 'resume' | 'cancel',
      guard: Guard,
    ) {
      if (!Number.isSafeInteger(jobId) || jobId < 0)
        throw new Error('Invalid Prusa job ID')
      const path = `/api/v1/job/${jobId}`
      switch (action) {
        case 'pause':
        case 'resume':
          await request(`${path}/${action}`, [204], { method: 'PUT' }, guard)
          return
        case 'cancel':
          await request(path, [204], { method: 'DELETE' }, guard)
          return
        default:
          throw new Error('Unsupported Prusa job action')
      }
    },
  }
}

export function createPrusaConnectLocal(
  endpoint: string,
  token: string,
  timeoutMs = 5000,
) {
  if (!token.trim()) throw new Error('Prusa Connect token required')
  const request = transport(
    endpoint,
    { Authorization: `Bearer ${token}` },
    timeoutMs,
  )
  const device = (id: string) => `/api/v1/devices/${segment(id)}`
  const read = async (path: string) => json(await request(path, [200]))
  const page = async (path: string) => {
    const response = await read(path)
    if (!Array.isArray(response.items))
      throw new Error('Malformed Prusa Connect page')
    return { ...response, items: response.items.map(record) }
  }
  return {
    discover: () => page('/api/v1/devices'),
    status: async (id: string) => {
      const response = await read(device(id))
      if (response.id !== id)
        throw new Error('Prusa Connect device identity mismatch')
      return response
    },
    camera: async (name: string) =>
      snapshot(
        await request(`/api/v1/cameras/${segment(name)}/snapshot`, [200, 204]),
      ),
    history: (id: string, cursor?: string) =>
      page(
        `${device(id)}/jobs/history${cursor === undefined ? '' : `?${new URLSearchParams({ cursor })}`}`,
      ),
  }
}
