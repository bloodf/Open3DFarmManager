/**
 * Websocket feeds of the pinned Spoolman v0.27.1 on the farm-scoped legacy
 * path: `/spoolman/<token>/api/v1/...`.
 *
 * Paths (as upstream): the root `/api/v1/`, one feed per entity
 * (`/vendor`, `/filament`, `/spool`, `/setting/`), one per record
 * (`/vendor/{id}`, `/filament/{id}`, `/spool/{id}`, `/setting/{key}`) and the
 * tag-scan feeds (`/tag/scan[/{reader_id}]`). Clients send nothing; the server
 * sends the upstream event JSON (`type`, `resource`, `date`, `payload`).
 *
 * The farm comes from the legacy credential in the path, as for HTTP, and is
 * fixed for the life of the connection: a client only ever hears its own
 * farm. The hooks have the shape of crossws hooks (what Nitro serves).
 */
import { legacyFailure } from './legacy-handler.ts'
import { spoolFeedBus, type SpoolFeedBus } from './events.ts'
import { splitLegacyPath } from './legacy-path.ts'
import type { SpoolLibraryStorage } from './scope.ts'

export interface FeedPeer {
  readonly context: Record<string, unknown>
  send(data: string): unknown
  close(code?: number, reason?: string): void
}

export interface FeedUpgradeRequest {
  readonly url: string
  readonly headers: Headers
  readonly context: Record<string, unknown>
}

export interface SpoolFeedHooks {
  upgrade(request: FeedUpgradeRequest): Promise<void>
  open(peer: FeedPeer): void
  message(peer: FeedPeer, message: unknown): void
  close(peer: FeedPeer): void
  error(peer: FeedPeer): void
}

interface Session {
  farmId: string
  /** Legacy credential that authenticated this feed; closed on revoke. */
  credentialId: string
  pool: readonly string[]
  /** Upstream accepts, then closes with this code. */
  refuse?: { code: number; reason: string }
  unsubscribe?: () => void
}

const SESSION = 'spoolFeed'
const MAX_ID = 2_147_483_647

/** Pool of an `/api/v1/...` feed path, or `undefined` when it is not a feed. */
export function feedPool(apiPath: string): readonly string[] | undefined {
  if (/^\/api\/v1\/?$/.test(apiPath)) return []
  let m = /^\/api\/v1\/(vendor|filament|spool)\/?$/.exec(apiPath)
  if (m) return [m[1]!]
  m = /^\/api\/v1\/(vendor|filament|spool)\/(\d{1,10})$/.exec(apiPath)
  if (m) {
    const id = Number(m[2])
    return id <= MAX_ID ? [m[1]!, String(id)] : undefined
  }
  if (/^\/api\/v1\/setting\/?$/.test(apiPath)) return ['setting']
  m = /^\/api\/v1\/setting\/([^/]+)$/.exec(apiPath)
  if (m) return ['setting', m[1]!]
  // The scan feeds are their own tree: they never hear entity changes.
  if (/^\/api\/v1\/tag\/scan\/?$/.test(apiPath)) return ['tag_scan']
  m = /^\/api\/v1\/tag\/scan\/([^/]+)$/.exec(apiPath)
  if (m) return ['tag_scan', m[1]!]
  return undefined
}

const reject = (status: number, text: string) =>
  new Response(JSON.stringify({ message: text }), {
    status,
    headers: { Connection: 'close' },
  })

function handshakeRefusal(
  headers: Headers,
): { code: number; reason: string } | undefined {
  const host = headers.get('host')
  if (!host) return { code: 4400, reason: 'Untrusted host' }
  const origin = headers.get('origin')
  if (origin === null) return undefined
  let originHost: string | undefined
  try {
    originHost = new URL(origin).host
  } catch {
    // "null" and malformed origins are untrusted.
  }
  const trusted = [host, headers.get('x-forwarded-host')]
  return originHost !== undefined && trusted.includes(originHost)
    ? undefined
    : { code: 4403, reason: 'Untrusted origin' }
}

export interface SpoolFeedOptions {
  /** The farm-scoped storage; rejects when the library is not enabled. */
  storage: () => Promise<SpoolLibraryStorage>
  bus?: SpoolFeedBus
}

export function createSpoolFeedHooks(
  options: SpoolFeedOptions,
): SpoolFeedHooks {
  const bus = options.bus ?? spoolFeedBus
  const sessionOf = (peer: FeedPeer) =>
    peer.context[SESSION] as Session | undefined

  const leave = (peer: FeedPeer) => {
    const session = sessionOf(peer)
    session?.unsubscribe?.()
    if (session) delete session.unsubscribe
  }

  return {
    async upgrade(request) {
      let path: ReturnType<typeof splitLegacyPath>
      try {
        path = splitLegacyPath(new URL(request.url).pathname)
      } catch {
        throw reject(400, 'Bad Request')
      }
      if (!path.ok) throw reject(401, 'Unauthorized')
      const pool = feedPool(path.apiPath)
      if (!pool) throw reject(404, 'Not Found')

      let farm
      try {
        const storage = await options.storage()
        farm = await storage.withScope(
          { kind: 'legacy-credential', token: path.token },
          async (repository) => ({ ok: true, value: repository.farmId }),
        )
      } catch (error) {
        const status = (error as { statusCode?: unknown } | null)?.statusCode
        throw status === 404
          ? reject(404, 'Not Found')
          : reject(503, 'Service Unavailable')
      }
      if (!farm.ok) {
        const failure = legacyFailure(farm.reason)
        throw reject(
          failure.status,
          (failure.body as { message: string }).message,
        )
      }
      const session: Session = {
        farmId: farm.value,
        credentialId: path.parsed.credentialId,
        pool,
      }
      const refuse = handshakeRefusal(request.headers)
      if (refuse) session.refuse = refuse
      request.context[SESSION] = session
    },

    open(peer) {
      const session = sessionOf(peer)
      if (!session) return peer.close(1011, 'Internal error')
      if (session.refuse)
        return peer.close(session.refuse.code, session.refuse.reason)
      const unsubscribe = bus.subscribe(
        session.farmId,
        session.pool,
        {
          send: (text) => peer.send(text),
          close: (code, reason) => peer.close(code, reason),
        },
        session.credentialId,
      )
      if (!unsubscribe) return peer.close(1013, 'Too many feeds')
      session.unsubscribe = unsubscribe
    },

    // Clients have nothing to say; upstream reads and discards.
    message() {},
    close: leave,
    error: leave,
  }
}
