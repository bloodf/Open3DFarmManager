import { request, type RequestOptions } from 'node:https'
import type { IncomingMessage } from 'node:http'
import {
  LIBRARY_RELAY_POLL_PATH,
  LibraryRelayPoll,
  libraryRelayBodyPath,
  libraryRelayResultPath,
  type LibraryRelayFailureReasonValue,
  type LibraryRelayOpValue,
  type LibraryRelayResultValue,
} from '../../../farm-protocol/src/library-relay.ts'
import { LibraryStoreError, type LibraryStore } from './library-store.ts'

/**
 * Connector side of the library relay (Connector storage mode). The Connector
 * opens every connection itself, with the credential headers telemetry and
 * library downloads already use: it polls for an operation, runs it on its own
 * library store and reports the result. Upload bytes are pulled in a separate
 * stream request, so they go from the browser upload through the server into
 * the store without the server keeping them.
 */
export interface LibraryRelayConfig {
  baseUrl: string
  headers(): Record<string, string>
  store: Pick<LibraryStore, 'put' | 'readRange' | 'purge' | 'sweep'>
  signal: AbortSignal
  /** Trust anchor for a private server certificate. */
  ca?: string | Buffer
  /** Operations run at once; the server hands out the next one as soon as one starts. */
  concurrency?: number
  retryMinMs?: number
  retryMaxMs?: number
  onDiagnostic?(event: { kind: 'library-relay-error'; reason: string }): void
}

const MAX_JSON = 1_048_576
const POLL_TIMEOUT_MS = 40_000
const REQUEST_TIMEOUT_MS = 120_000

const FAILURE: Partial<Record<string, LibraryRelayFailureReasonValue>> = {
  'too-large': 'too-large',
  'quota-exceeded': 'quota-exceeded',
  'disk-full': 'disk-full',
  'not-found': 'not-found',
  'hash-mismatch': 'hash-mismatch',
}
const failureOf = (error: unknown): LibraryRelayFailureReasonValue =>
  (error instanceof LibraryStoreError && FAILURE[error.code]) || 'failed'

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

async function readJson(response: IncomingMessage): Promise<unknown> {
  let size = 0
  const parts: Buffer[] = []
  for await (const chunk of response) {
    size += (chunk as Buffer).length
    if (size > MAX_JSON) {
      response.destroy()
      throw new Error('relay response too large')
    }
    parts.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}

export function createLibraryRelay(config: LibraryRelayConfig) {
  const base = new URL(config.baseUrl)
  if (base.protocol !== 'https:' || base.username || base.password)
    throw new Error('Invalid library server URL')
  const { store, signal } = config

  function call(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: Uint8Array; contentType?: string; timeoutMs: number },
  ): Promise<IncomingMessage> {
    const url = new URL(path, base)
    const headers: Record<string, string> = {
      ...config.headers(),
      ...(options.body
        ? {
            'content-type': options.contentType ?? 'application/json',
            'content-length': String(options.body.byteLength),
          }
        : method === 'POST'
          ? { 'content-length': '0' }
          : {}),
    }
    const init: RequestOptions = {
      method,
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
      ...(config.ca ? { ca: config.ca } : {}),
    }
    return new Promise((resolve, reject) => {
      const req = request(url, init, resolve)
      req.on('error', reject)
      req.end(options.body ? Buffer.from(options.body) : undefined)
    })
  }

  async function report(
    opId: string,
    result: LibraryRelayResultValue | { bytes: Uint8Array },
  ): Promise<void> {
    const response =
      'bytes' in result
        ? await call('POST', libraryRelayResultPath(opId), {
            body: result.bytes,
            contentType: 'application/octet-stream',
            timeoutMs: REQUEST_TIMEOUT_MS,
          })
        : await call('POST', libraryRelayResultPath(opId), {
            body: Buffer.from(JSON.stringify(result)),
            timeoutMs: REQUEST_TIMEOUT_MS,
          })
    response.resume()
    await new Promise((resolve) => response.once('close', resolve))
  }

  async function put(
    op: Extract<LibraryRelayOpValue, { type: 'put' }>,
  ): Promise<LibraryRelayResultValue> {
    const body = await call('GET', libraryRelayBodyPath(op.op_id), {
      timeoutMs: REQUEST_TIMEOUT_MS * 10,
    })
    if (body.statusCode !== 200) {
      body.resume()
      return { ok: false, reason: 'failed' }
    }
    const stored = await store.put(body, { maxBytes: op.max_bytes })
    return {
      ok: true,
      type: 'put',
      sha256: stored.sha256,
      size: stored.size,
      created: stored.created,
    }
  }

  async function execute(op: LibraryRelayOpValue): Promise<void> {
    try {
      if (op.type === 'read') {
        const bytes = await store.readRange(op.sha256, op.offset, op.length)
        await report(op.op_id, { bytes })
        return
      }
      let result: LibraryRelayResultValue
      if (op.type === 'put') result = await put(op)
      else if (op.type === 'discard') {
        await store.purge([op.sha256])
        result = { ok: true, type: 'discard' }
      } else if (op.type === 'purge')
        result = {
          ok: true,
          type: 'purge',
          removed: await store.purge(op.sha256s),
        }
      else
        result = {
          ok: true,
          type: 'sweep',
          removed: await store.sweep(op.referenced),
        }
      await report(op.op_id, result)
    } catch (error) {
      if (signal.aborted) return
      // Never leaves the server waiting for a reason: tell it, then move on.
      await report(op.op_id, { ok: false, reason: failureOf(error) }).catch(
        () => {},
      )
    }
  }

  async function poll(): Promise<LibraryRelayOpValue | null> {
    const response = await call('POST', LIBRARY_RELAY_POLL_PATH, {
      timeoutMs: POLL_TIMEOUT_MS,
    })
    if (response.statusCode === 204) {
      response.resume()
      return null
    }
    if (response.statusCode !== 200) {
      response.resume()
      throw new Error(`relay poll answered ${response.statusCode}`)
    }
    return LibraryRelayPoll.parse(await readJson(response)).op
  }

  /** Runs until the signal aborts; one failed poll backs off, never ends the loop. */
  async function run(): Promise<void> {
    const limit = Math.max(1, config.concurrency ?? 4)
    const minMs = config.retryMinMs ?? 1000
    const maxMs = config.retryMaxMs ?? 30_000
    const running = new Set<Promise<void>>()
    let backoff = minMs
    while (!signal.aborted) {
      if (running.size >= limit) {
        await Promise.race(running)
        continue
      }
      try {
        const op = await poll()
        backoff = minMs
        if (op) {
          const task: Promise<void> = execute(op).finally(() =>
            running.delete(task),
          )
          running.add(task)
        }
      } catch (error) {
        if (signal.aborted) break
        config.onDiagnostic?.({
          kind: 'library-relay-error',
          reason: error instanceof Error ? error.message : 'poll failed',
        })
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, maxMs)
      }
    }
    await Promise.allSettled(running)
  }

  return { run }
}
