import { z } from 'zod'
import { parseBoundedJson } from '../../../farm-protocol/src/json.ts'

export type KobraLinkErrorCode =
  'unavailable' | 'unauthorized' | 'invalid' | 'identity_changed' | 'timeout'
export class KobraLinkError extends Error {
  readonly code: KobraLinkErrorCode
  constructor(code: KobraLinkErrorCode) {
    super(`KobraLink: ${code}`)
    this.code = code
  }
}
const fail = (code: KobraLinkErrorCode): never => {
  throw new KobraLinkError(code)
}
const text = z.string().min(1).max(128)
const bindingSchema = z.strictObject({
  id: text.regex(/^[A-Za-z0-9_-]+$/),
  deviceId: text,
})
export type PrinterBinding = z.infer<typeof bindingSchema>
const liveSchema = z.object({
  connected: z.boolean().optional(),
  progress: z.number().finite().min(0).max(1).optional(),
  updatedAt: z.number().finite().optional(),
  firmwareVersion: text.optional(),
  printState: text.optional(),
  kobraState: text.optional(),
  connectionError: z.object({ code: text }).nullable().optional(),
})
const printerSchema = z.object({
  id: text.regex(/^[A-Za-z0-9_-]+$/),
  deviceId: text,
  name: z.string().max(128),
  live: liveSchema.nullable().optional(),
})
export interface PrinterStatus extends PrinterBinding {
  name: string
  availability: 'available' | 'unavailable' | 'disconnected'
  printState:
    | 'printing'
    | 'paused'
    | 'pausing'
    | 'complete'
    | 'standby'
    | 'error'
    | 'unknown'
  firmware: string | null
  model: 'Kobra X'
  modelEvidence: 'user_declared_unverified'
}
export interface PrinterObservation extends PrinterStatus {
  progress: number | null
  observedAt: number | null
}
export type KobraLinkFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>
export interface KobraLinkOptions {
  origin: string
  allowedOrigins: readonly string[]
  timeoutMs?: number
  staleAfterMs?: number
  signal?: AbortSignal
  fetch?: KobraLinkFetch
}
function originOnly(value: string): string {
  try {
    const url = new URL(value)
    const parts = url.hostname.split('.').map(Number)
    const [a, b] = parts
    const privateHost =
      url.hostname === '[::1]' ||
      (parts.length === 4 &&
        parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
        (a === 127 ||
          a === 10 ||
          (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
          (a === 192 && b === 168)))
    if (
      !privateHost ||
      !['http:', 'https:'].includes(url.protocol) ||
      value !== url.origin ||
      url.username ||
      url.password
    )
      return fail('invalid')
    return url.origin
  } catch {
    return fail('invalid')
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  return result.success ? result.data : fail('invalid')
}

/** Connector-local custody only. Authentication routes/cookies remain unverified against a live bridge. */
export function createKobraLinkClient(options: KobraLinkOptions) {
  const origin = originOnly(options.origin)
  if (!options.allowedOrigins.map(originOnly).includes(origin)) fail('invalid')
  const timeoutMs = parse(
    z.number().int().min(1).max(60_000),
    options.timeoutMs ?? 5000,
  )
  const staleAfterMs = parse(
    z.number().int().min(1).max(300_000),
    options.staleAfterMs ?? 15_000,
  )
  const transport = options.fetch ?? fetch
  let cookie = ''
  let generation = 0
  let creating = false
  const identities = new Map<string, string>()
  async function request(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    auth = false,
    expectedGeneration = generation,
  ): Promise<unknown> {
    if (expectedGeneration !== generation) fail('unauthorized')
    if (options.signal?.aborted) fail('unavailable')
    if (!auth && path !== '/api/v1/setup/status' && !cookie)
      fail('unauthorized')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel: () => void = () => {}
    const deadline = new Promise<never>((_, reject) => {
      cancel = () => {
        controller.abort()
        reject(new KobraLinkError('unavailable'))
      }
      options.signal?.addEventListener('abort', cancel, { once: true })
      if (options.signal?.aborted) cancel()
      timer = setTimeout(() => {
        controller.abort()
        reject(new KobraLinkError('timeout'))
      }, timeoutMs)
    })
    const operation = async () => {
      const response = await transport(origin + path, {
        method,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          Origin: origin,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (controller.signal.aborted) fail('timeout')
      if (expectedGeneration !== generation) fail('unauthorized')
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        fail('invalid')
      if (response.status === 401 || response.status === 403) {
        cookie = ''
        generation++
        fail('unauthorized')
      }
      if (!response.ok)
        fail(response.status === 400 ? 'invalid' : 'unavailable')
      if (auth) {
        void response.body?.cancel().catch(() => {})
        const cookies = response.headers.getSetCookie()
        const secure = origin.startsWith('https:')
        const name = `${secure ? '__Secure-' : ''}better-auth.session_token`
        const tokens = cookies.filter((value) =>
          /^(?:__Secure-|__Host-)?better-auth\.session_token=/.test(value),
        )
        if (cookies.join('; ').length > 8192 || tokens.length !== 1)
          fail('invalid')
        const token = tokens[0] ?? ''
        const [pair = '', ...attributes] = token.split(';')
        const attrs = attributes.map((value) => value.trim().toLowerCase())
        if (
          !pair.startsWith(`${name}=`) ||
          !/^[A-Za-z0-9_.-]+=[\x21-\x2B\x2D-\x3A\x3C-\x7E]+$/.test(pair) ||
          attrs.some((value) => value.startsWith('domain=')) ||
          attrs.some(
            (value) => value.startsWith('path=') && value !== 'path=/',
          ) ||
          attrs.includes('secure') !== secure ||
          (response.url && new URL(response.url).origin !== origin)
        )
          fail('invalid')
        cookie = pair
        return { contract: 'unverified' }
      }
      if (response.status === 204) return null
      if (
        response.headers.get('content-type')?.split(';')[0]?.trim() !==
          'application/json' ||
        !response.body
      )
        fail('invalid')
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536))
        fail('invalid')
      const stream = response.body
      if (!stream) return fail('invalid')
      const reader = stream.getReader()
      const cancel = () => {
        void reader.cancel().catch(() => {})
      }
      controller.signal.addEventListener('abort', cancel, { once: true })
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (controller.signal.aborted) fail('timeout')
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 65536) fail('invalid')
          chunks.push(chunk.value)
        }
      } finally {
        controller.signal.removeEventListener('abort', cancel)
        cancel()
        reader.releaseLock()
      }
      try {
        return parseBoundedJson(
          new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
          { maxBytes: 65536, maxDepth: 12, maxValues: 4096 },
        )
      } catch {
        return fail('invalid')
      }
    }
    try {
      return await Promise.race([operation(), deadline])
    } catch (error) {
      if (error instanceof KobraLinkError) throw error
      return fail('unavailable')
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      clearTimeout(timer)
      controller.abort()
    }
  }
  function observe(
    value: unknown,
    expected?: PrinterBinding,
  ): PrinterObservation {
    const p = parse(printerSchema, value)
    if (
      (expected &&
        (p.id !== expected.id || p.deviceId !== expected.deviceId)) ||
      (identities.has(p.id) && identities.get(p.id) !== p.deviceId)
    )
      fail('identity_changed')
    identities.set(p.id, p.deviceId)
    const live = p.live
    const fresh =
      live?.updatedAt !== undefined &&
      Date.now() >= live.updatedAt &&
      Date.now() - live.updatedAt <= staleAfterMs
    const availability =
      live?.connected === false
        ? 'disconnected'
        : live?.connected === true && fresh
          ? 'available'
          : 'unavailable'
    const state = live?.kobraState === 'pausing' ? 'pausing' : live?.printState
    const printState =
      availability === 'available' &&
      (state === 'printing' ||
        state === 'paused' ||
        state === 'pausing' ||
        state === 'complete' ||
        state === 'standby' ||
        state === 'error')
        ? state
        : 'unknown'
    return {
      id: p.id,
      deviceId: p.deviceId,
      name: p.name,
      availability,
      printState,
      progress: live?.progress ?? null,
      observedAt: live?.updatedAt ?? null,
      firmware:
        live?.firmwareVersion && live.firmwareVersion !== 'unknown'
          ? live.firmwareVersion
          : null,
      model: 'Kobra X',
      modelEvidence: 'user_declared_unverified',
    }
  }
  function sanitize(value: unknown, expected?: PrinterBinding): PrinterStatus {
    const {
      progress: _progress,
      observedAt: _observedAt,
      ...status
    } = observe(value, expected)
    return status
  }
  async function getPrinterObservation(
    binding: PrinterBinding,
  ): Promise<PrinterObservation> {
    const b = parse(bindingSchema, binding)
    return observe(
      await request(`/api/v1/printers/${encodeURIComponent(b.id)}`, 'GET'),
      b,
    )
  }
  async function listPrinters(): Promise<PrinterStatus[]> {
    return parse(
      z.array(z.unknown()).max(256),
      await request('/api/v1/printers', 'GET'),
    ).map((p) => sanitize(p))
  }
  async function getPrinter(binding: PrinterBinding): Promise<PrinterStatus> {
    const b = parse(bindingSchema, binding)
    return sanitize(
      await request(`/api/v1/printers/${encodeURIComponent(b.id)}`, 'GET'),
      b,
    )
  }
  return {
    authContract: 'unverified' as const,
    clearSession() {
      generation++
      cookie = ''
    },
    async setupStatus() {
      return parse(
        z.object({ needsSetup: z.boolean() }),
        await request('/api/v1/setup/status', 'GET'),
      )
    },
    async authenticate(input: {
      ownership: 'fresh_owned'
      mode: 'signup' | 'signin'
      name: string
      email: string
      password: string
    }) {
      const authGeneration = ++generation
      cookie = ''
      const data = parse(
        z.strictObject({
          ownership: z.literal('fresh_owned'),
          mode: z.enum(['signup', 'signin']),
          name: z.string().min(1).max(128),
          email: z.email().max(254),
          password: z.string().min(8).max(256),
        }),
        input,
      )
      cookie = ''
      if (
        data.mode === 'signup' &&
        !parse(
          z.object({ needsSetup: z.boolean() }),
          await request('/api/v1/setup/status', 'GET'),
        ).needsSetup
      )
        fail('unauthorized')
      return request(
        `/api/auth/${data.mode === 'signup' ? 'sign-up' : 'sign-in'}/email`,
        'POST',
        {
          email: data.email,
          password: data.password,
          ...(data.mode === 'signup' ? { name: data.name } : {}),
        },
        true,
        authGeneration,
      )
    },
    listPrinters,
    getPrinter,
    getPrinterObservation,
    async createOrReconcile(input: {
      ip: string
      deviceId: string
      name: string
    }) {
      const data = parse(
        z.strictObject({
          ip: z.ipv4(),
          deviceId: text,
          name: z.string().min(1).max(64),
        }),
        input,
      )
      originOnly(`http://${data.ip}`)
      if (creating) fail('unavailable')
      creating = true
      try {
        const find = async () => {
          const matches = (await listPrinters()).filter(
            (p) => p.deviceId === data.deviceId,
          )
          if (matches.length > 1) fail('identity_changed')
          return matches[0]
        }
        const existing = await find()
        if (existing) return existing
        try {
          const result = parse(
            printerSchema,
            await request('/api/v1/printers', 'POST', {
              ip: data.ip,
              name: data.name,
            }),
          )
          if (result.deviceId !== data.deviceId) fail('identity_changed')
          return sanitize(result)
        } catch (error) {
          if (
            !(error instanceof KobraLinkError) ||
            !['unavailable', 'timeout'].includes(error.code)
          )
            throw error
          const found = await find()
          if (found) return found
          throw error
        }
      } finally {
        creating = false
      }
    },
    async reconnect(
      binding: PrinterBinding,
    ): Promise<{ accepted: true; confirmed: false }> {
      const current = await getPrinter(binding)
      if (current.availability !== 'disconnected') fail('unavailable')
      const wire = parse(
        printerSchema,
        await request(
          `/api/v1/printers/${encodeURIComponent(current.id)}`,
          'GET',
        ),
      )
      sanitize(wire, binding)
      if (
        wire.live?.connectionError?.code === 'manual' ||
        wire.live?.connectionError?.code === 'reconnecting' ||
        wire.live?.connected !== false
      )
        fail('unavailable')
      await request(
        `/api/v1/printers/${encodeURIComponent(current.id)}/reconnect`,
        'POST',
      )
      return { accepted: true, confirmed: false }
    },
  }
}
