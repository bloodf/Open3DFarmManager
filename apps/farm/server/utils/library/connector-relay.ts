import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createError } from 'nuxt/server'
import {
  LIBRARY_RELAY_MAX_PURGE,
  LIBRARY_RELAY_MAX_READ,
  LIBRARY_RELAY_MAX_SWEEP,
  LIBRARY_RELAY_OP_ID,
  LIBRARY_RELAY_POLL_MS,
  LibraryRelayResult,
  type LibraryRelayFailureReasonValue,
  type LibraryRelayOpValue,
} from '../../../../../packages/farm-protocol/src/library-relay.ts'
import {
  createConnectorLibraryAuthenticator,
  type ConnectorCredentialPolicy,
  type ConnectorEnrollmentReader,
  type ConnectorIdentity,
} from './connector-download.ts'
import { BlobStoreError } from './blob-store.ts'
import type { ConnectorLibraryPort } from './retention.ts'
import type { ConnectorLibraryRelay } from './routes.ts'

/**
 * Server side of the Connector library relay. The server cannot dial a
 * Connector (it sits behind the farm's NAT), so every operation waits for the
 * Connector's own authenticated request: it polls, is handed one operation,
 * pulls an upload's bytes through a stream request and posts the result. The
 * server keeps no file bytes: an upload is piped straight through and a read is
 * a bounded range handed back to the parser. Operations live in this process
 * only; a restart fails the ones in flight and the caller retries.
 */

export const RELAY_MAX_QUEUED_PER_AGENT = 64
const DEFAULT_CLAIM_MS = 20_000
const DEFAULT_RUN_MS = 60_000
const MAX_RESULT_JSON_BYTES = 1_048_576

export interface ConnectorRelayOptions {
  authenticate(headers: Headers): Promise<ConnectorIdentity | null>
  /** How long an operation may wait for the Connector to pick it up. */
  claimMs?: number
  /** Longest silence while a claimed operation runs. */
  runMs?: number
  pollMs?: number
}

type Outcome =
  | {
      kind: 'json'
      value: ReturnType<typeof LibraryRelayResult.parse>
      streamed?: { sha256: string; size: number } | undefined
    }
  | { kind: 'bytes'; bytes: Uint8Array }

interface Operation {
  id: string
  agentId: string
  farmId: string | undefined
  spec: LibraryRelayOpValue
  claimed: boolean
  body: AsyncIterable<Uint8Array> | undefined
  bodyTaken: boolean
  streamed?: { sha256: string; size: number }
  timer: ReturnType<typeof setTimeout> | undefined
  succeed(outcome: Outcome): void
  fail(error: unknown): void
}
interface Waiter {
  farmId: string
  give(op: LibraryRelayOpValue | null): void
}

const failureError = (reason: LibraryRelayFailureReasonValue): Error => {
  switch (reason) {
    case 'too-large':
      return new BlobStoreError(
        'too-large',
        'O arquivo excede o limite de 512 MiB.',
      )
    case 'quota-exceeded':
      return createError({
        status: 507,
        message: 'A cota da biblioteca no Conector foi atingida.',
      })
    case 'disk-full':
      return createError({
        status: 507,
        message: 'O disco do computador do Conector está cheio.',
      })
    default:
      return new Error(`Connector relay failed: ${reason}`)
  }
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => {})
        return null
      }
      parts.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(parts)
}

export class ConnectorLibraryRelayHub
  implements ConnectorLibraryRelay, ConnectorLibraryPort
{
  private readonly ops = new Map<string, Operation>()
  private readonly queues = new Map<string, Operation[]>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly claimMs: number
  private readonly runMs: number
  private readonly pollMs: number
  private readonly authenticate: ConnectorRelayOptions['authenticate']

  constructor(options: ConnectorRelayOptions) {
    this.authenticate = options.authenticate
    this.claimMs = options.claimMs ?? DEFAULT_CLAIM_MS
    this.runMs = options.runMs ?? DEFAULT_RUN_MS
    this.pollMs = options.pollMs ?? LIBRARY_RELAY_POLL_MS
  }

  // ---- server callers (routes and retention) -------------------------------

  async put(input: {
    farmId: string
    agentId: string
    body: AsyncIterable<Uint8Array>
    maxBytes: number
  }): Promise<{ sha256: string; size: number; created: boolean }> {
    const outcome = await this.enqueue(
      input.agentId,
      input.farmId,
      { type: 'put', max_bytes: input.maxBytes },
      input.body,
    )
    if (
      outcome.kind !== 'json' ||
      !outcome.value.ok ||
      outcome.value.type !== 'put'
    )
      throw new Error('Connector relay answered out of turn')
    const { sha256, size, created } = outcome.value
    const { streamed } = outcome
    if (streamed?.sha256 !== sha256 || streamed.size !== size) {
      if (created) {
        await this.discard({
          farmId: input.farmId,
          agentId: input.agentId,
          sha256,
        }).catch(() => {})
      }
      throw new Error('O Conector retornou dados de integridade divergentes.')
    }
    return { sha256, size, created }
  }

  async read(input: {
    farmId: string
    agentId: string
    sha256: string
    offset: number
    length: number
  }): Promise<Uint8Array> {
    const parts: Uint8Array[] = []
    let offset = input.offset
    let remaining = input.length
    while (remaining > 0) {
      const length = Math.min(remaining, LIBRARY_RELAY_MAX_READ)
      const outcome = await this.enqueue(input.agentId, input.farmId, {
        type: 'read',
        sha256: input.sha256,
        offset,
        length,
      })
      if (outcome.kind !== 'bytes')
        throw new Error('Connector relay answered out of turn')
      parts.push(outcome.bytes)
      // A short answer is the end of the file.
      if (outcome.bytes.byteLength < length) break
      offset += length
      remaining -= length
    }
    return Buffer.concat(parts)
  }

  async discard(input: {
    farmId: string
    agentId: string
    sha256: string
  }): Promise<void> {
    await this.enqueue(input.agentId, input.farmId, {
      type: 'discard',
      sha256: input.sha256,
    })
  }

  async purge(agentId: string, sha256s: readonly string[]): Promise<string[]> {
    const removed: string[] = []
    for (let i = 0; i < sha256s.length; i += LIBRARY_RELAY_MAX_PURGE) {
      const outcome = await this.enqueue(agentId, undefined, {
        type: 'purge',
        sha256s: sha256s.slice(i, i + LIBRARY_RELAY_MAX_PURGE),
      })
      if (
        outcome.kind === 'json' &&
        outcome.value.ok &&
        outcome.value.type === 'purge'
      )
        removed.push(...outcome.value.removed)
    }
    return removed
  }

  async sweep(
    agentId: string,
    referenced: readonly string[],
  ): Promise<string[]> {
    if (referenced.length > LIBRARY_RELAY_MAX_SWEEP)
      throw new Error('Too many referenced files for one sweep')
    const outcome = await this.enqueue(agentId, undefined, {
      type: 'sweep',
      referenced: [...referenced],
    })
    return outcome.kind === 'json' &&
      outcome.value.ok &&
      outcome.value.type === 'sweep'
      ? outcome.value.removed
      : []
  }

  // ---- queue ---------------------------------------------------------------

  private enqueue(
    agentId: string,
    farmId: string | undefined,
    spec: DistributiveOmit<LibraryRelayOpValue, 'op_id'>,
    body?: AsyncIterable<Uint8Array>,
  ): Promise<Outcome> {
    const queue = this.queues.get(agentId) ?? []
    if (queue.length >= RELAY_MAX_QUEUED_PER_AGENT)
      return Promise.reject(new Error('Connector relay is busy'))
    return new Promise<Outcome>((resolve, reject) => {
      const id = randomUUID()
      const op: Operation = {
        id,
        agentId,
        farmId,
        spec: { ...spec, op_id: id } as LibraryRelayOpValue,
        claimed: false,
        body,
        bodyTaken: false,
        timer: undefined,
        succeed: (outcome) => {
          this.finish(op)
          resolve(outcome)
        },
        fail: (error) => {
          this.finish(op)
          reject(error)
        },
      }
      this.ops.set(id, op)
      const waiter = this.waiters.get(agentId)
      if (waiter && (!farmId || waiter.farmId === farmId)) {
        this.waiters.delete(agentId)
        this.claim(op)
        waiter.give(op.spec)
        return
      }
      this.queues.set(agentId, [...queue, op])
      this.arm(
        op,
        this.claimMs,
        'O Conector não respondeu. Verifique se ele está online.',
      )
    })
  }

  private arm(op: Operation, ms: number, message: string) {
    clearTimeout(op.timer)
    op.timer = setTimeout(() => op.fail(new Error(message)), ms)
    op.timer.unref()
  }

  private claim(op: Operation) {
    op.claimed = true
    const queue = this.queues.get(op.agentId)
    if (queue)
      this.queues.set(
        op.agentId,
        queue.filter((entry) => entry !== op),
      )
    this.arm(op, this.runMs, 'O Conector parou de responder.')
  }

  private finish(op: Operation) {
    clearTimeout(op.timer)
    this.ops.delete(op.id)
    const queue = this.queues.get(op.agentId)
    if (queue)
      this.queues.set(
        op.agentId,
        queue.filter((entry) => entry !== op),
      )
    if (op.body && !op.bodyTaken) {
      // Never pulled: stop reading the caller's upload.
      const iterator = op.body[Symbol.asyncIterator]()
      void Promise.resolve(iterator.return?.()).catch(() => {})
    }
  }

  // ---- Connector side (authenticated HTTPS) --------------------------------

  /** Hands the Connector its next operation, or null after the poll window. */
  async poll(
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<{
    identity: ConnectorIdentity
    op: LibraryRelayOpValue | null
  } | null> {
    const identity = await this.authenticate(headers)
    if (!identity) return null
    const { agentId, farmId } = identity
    const queued = (this.queues.get(agentId) ?? []).find(
      (op) => !op.farmId || op.farmId === farmId,
    )
    if (queued) {
      this.claim(queued)
      return { identity, op: queued.spec }
    }
    // One open poll per Connector: a newer one replaces the older.
    this.waiters.get(agentId)?.give(null)
    const op = await new Promise<LibraryRelayOpValue | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiter: Waiter = {
        farmId,
        give: (value) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', leave)
          resolve(value)
        },
      }
      const leave = () => {
        if (this.waiters.get(agentId) === waiter) this.waiters.delete(agentId)
        waiter.give(null)
      }
      timer = setTimeout(leave, this.pollMs)
      timer.unref()
      signal?.addEventListener('abort', leave, { once: true })
      this.waiters.set(agentId, waiter)
    })
    return { identity, op }
  }

  private owned(identity: ConnectorIdentity, opId: string): Operation | null {
    if (!LIBRARY_RELAY_OP_ID.test(opId)) return null
    const op = this.ops.get(opId)
    return op &&
      op.claimed &&
      op.agentId === identity.agentId &&
      (!op.farmId || op.farmId === identity.farmId)
      ? op
      : null
  }

  /** The upload's bytes, once, capped at the operation's `max_bytes`. */
  async body(
    headers: Headers,
    opId: string,
  ): Promise<
    { status: 200; stream: Readable } | { status: 401 | 403 | 404 | 409 | 503 }
  > {
    let identity: ConnectorIdentity | null
    try {
      identity = await this.authenticate(headers)
    } catch {
      return { status: 503 }
    }
    if (!identity) return { status: 403 }
    const op = this.owned(identity, opId)
    if (!op || op.spec.type !== 'put' || !op.body) return { status: 404 }
    if (op.bodyTaken) return { status: 409 }
    op.bodyTaken = true
    const { max_bytes: max } = op.spec
    const source = op.body
    const hub = this
    let sent = 0
    const stream = Readable.from(
      (async function* () {
        const hash = createHash('sha256')
        try {
          for await (const chunk of source) {
            sent += chunk.byteLength
            if (sent > max)
              throw new BlobStoreError(
                'too-large',
                'O arquivo excede o limite de 512 MiB.',
              )
            hash.update(chunk)
            hub.arm(op, hub.runMs, 'O Conector parou de responder.')
            yield chunk
          }
          op.streamed = { sha256: hash.digest('hex'), size: sent }
        } catch (error) {
          // The caller's upload failed or was too big: the operation fails with it.
          op.fail(error)
          throw error
        }
      })(),
    )
    return { status: 200, stream }
  }

  /** Completes an operation with the Connector's JSON result or the bytes of a read. */
  async result(
    headers: Headers,
    opId: string,
    contentType: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<{ status: 204 | 400 | 403 | 404 | 413 | 503 }> {
    let identity: ConnectorIdentity | null
    try {
      identity = await this.authenticate(headers)
    } catch {
      return { status: 503 }
    }
    if (!identity) return { status: 403 }
    const op = this.owned(identity, opId)
    if (!op) return { status: 404 }
    if (contentType.split(';')[0]?.trim() === 'application/octet-stream') {
      if (op.spec.type !== 'read') return { status: 400 }
      const bytes = await readCapped(body, op.spec.length)
      if (!bytes) return { status: 413 }
      op.succeed({ kind: 'bytes', bytes })
      return { status: 204 }
    }
    const raw = await readCapped(body, MAX_RESULT_JSON_BYTES)
    if (!raw) return { status: 413 }
    let parsed: ReturnType<typeof LibraryRelayResult.safeParse>
    try {
      parsed = LibraryRelayResult.safeParse(
        JSON.parse(Buffer.from(raw).toString('utf8')),
      )
    } catch {
      return { status: 400 }
    }
    if (!parsed.success) return { status: 400 }
    const value = parsed.data
    if (!value.ok) {
      op.fail(failureError(value.reason))
      return { status: 204 }
    }
    if (value.type !== op.spec.type) return { status: 400 }
    op.succeed({ kind: 'json', value, streamed: op.streamed })
    return { status: 204 }
  }

  /** Fails every operation in flight (shutdown). */
  close(): void {
    for (const op of [...this.ops.values()])
      op.fail(new Error('Connector relay closed'))
    for (const waiter of this.waiters.values()) waiter.give(null)
    this.waiters.clear()
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

// ---- activation ------------------------------------------------------------

let active: ConnectorLibraryRelayHub | undefined

/** Called by trusted Node startup after explicit configuration. */
export function startConnectorLibraryRelay(
  input: Omit<ConnectorRelayOptions, 'authenticate'> & {
    credentials: ConnectorCredentialPolicy
    enrollments: ConnectorEnrollmentReader
    now?: () => number
  },
): { hub: ConnectorLibraryRelayHub; stop(): void } {
  if (active) throw new Error('Library relay already active')
  const { credentials, enrollments, now, ...rest } = input
  const hub = new ConnectorLibraryRelayHub({
    ...rest,
    authenticate: createConnectorLibraryAuthenticator({
      credentials,
      enrollments,
      ...(now ? { now } : {}),
    }),
  })
  active = hub
  return {
    hub,
    stop() {
      if (active !== hub) return
      active = undefined
      hub.close()
    },
  }
}

export function activeConnectorLibraryRelay():
  ConnectorLibraryRelayHub | undefined {
  return active
}

const current = (): ConnectorLibraryRelayHub => {
  if (!active) throw new Error('Connector relay is not running')
  return active
}

/**
 * What the library runtime hands the routes: resolves the running hub on each
 * call, so an upload answers 503 until the relay has started and works after.
 */
export const connectorLibraryRelay: ConnectorLibraryRelay &
  ConnectorLibraryPort = {
  put: (input) => current().put(input),
  read: (input) => current().read(input),
  discard: (input) => current().discard(input),
  purge: (agentId, sha256s) => current().purge(agentId, sha256s),
  sweep: (agentId, referenced) => current().sweep(agentId, referenced),
}
