import type { SignallingMode } from './signalling-negotiation-adapter.ts'
import { IncomingMessage } from 'node:http'
import type { SessionConfig } from 'nuxt/server'
import { sealedSessionRecordId } from './authenticated-session.ts'
import {
  checkMutationOrigin,
  configuredAuthOrigin,
} from '../utils/auth/boundary.ts'

export const SIGNALLING_SUBPROTOCOL = 'open3dfarm.signalling.v1'
export const PAUSE_SIGNALLING_SUBPROTOCOL = 'open3dfarm.pause-signalling.v1'
export const CONFIGURATION_SIGNALLING_SUBPROTOCOL =
  'open3dfarm.config-signalling.v1'
/** config-v1 has its own endpoints, subprotocol and runtime; it is never a SignallingMode. */
export type SignallingUpgradeMode = SignallingMode | 'configuration'
export const SIGNALLING_NATIVE_MAX_PAYLOAD = 12 * 1024
export const SIGNALLING_PENDING_BYTE_LIMIT = 32 * 1024
export const SIGNALLING_PREAUTH_LIMIT = 16
export const SIGNALLING_ADMISSION_TIMEOUT_MS = 8000
export type SignallingSocketRole = 'browser' | 'connector'
const paths = {
  'read-only': {
    browser: '/api/signalling/browser',
    connector: '/api/signalling/connector',
  },
  pause: {
    browser: '/api/signalling/pause-browser',
    connector: '/api/signalling/pause-connector',
  },
  configuration: {
    browser: '/api/signalling/config-browser',
    connector: '/api/signalling/config-connector',
  },
}
const subprotocols = {
  'read-only': SIGNALLING_SUBPROTOCOL,
  pause: PAUSE_SIGNALLING_SUBPROTOCOL,
  configuration: CONFIGURATION_SIGNALLING_SUBPROTOCOL,
}
function object(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/** Nitro 2.13.6 initializes plugins before node-server constructs its CrossWS adapter.
 * Force and validate h3's cached options here. If another consumer already cached
 * incompatible options, startup fails instead of applying an ineffective post-parse cap. */
export function installSignallingWebSocketBounds(app: unknown): void {
  if (
    !object(app) ||
    !('options' in app) ||
    !object(app.options) ||
    !('websocket' in app)
  )
    throw new Error('Unsupported signalling WebSocket runtime')
  const previous =
    'websocket' in app.options ? app.options.websocket : undefined
  if (previous !== undefined && !object(previous))
    throw new Error('Unsupported WebSocket options')
  if (previous && 'wss' in previous)
    throw new Error('Preconstructed WebSocket server is unsupported')
  if (previous && 'hooks' in previous)
    throw new Error('Preconfigured WebSocket hooks are unsupported')
  const nativeLimits = Object.freeze({
    maxPayload: SIGNALLING_NATIVE_MAX_PAYLOAD,
    perMessageDeflate: false,
    autoPong: false,
  })
  const options = Object.freeze({
    ...previous,
    serverOptions: nativeLimits,
    hooks: Object.freeze({
      upgrade(input: unknown) {
        // CrossWS calls this synchronously before resolving any route hooks.
        // Throw a Response so its Node adapter ends the socket without an
        // outer listener catch (Nitro does not install one).
        try {
          const request = signallingNodeUpgrade(input)
          if (
            request.method === 'GET' &&
            Object.values(paths).some(
              (mode) =>
                request.url === mode.browser || request.url === mode.connector,
            )
          )
            return
        } catch {}
        throw new Response(null, { status: 404 })
      },
    }),
  })
  Object.assign(app.options, { websocket: options })
  const resolved = app.websocket
  if (
    !object(resolved) ||
    !('serverOptions' in resolved) ||
    resolved.serverOptions !== nativeLimits ||
    'wss' in resolved ||
    !('resolve' in resolved) ||
    typeof resolved.resolve !== 'function'
  )
    throw new Error(
      'WebSocket bounds were not installed before adapter initialization',
    )
  const resolve = resolved.resolve.bind(resolved)
  Object.assign(resolved, {
    async resolve(input: unknown) {
      const hooks: unknown = await resolve(input)
      return {
        ...(object(hooks) ? hooks : {}),
        async upgrade(request: unknown) {
          if (
            !object(hooks) ||
            !('upgrade' in hooks) ||
            typeof hooks.upgrade !== 'function'
          )
            throw new Response(null, { status: 503 })
          try {
            return await hooks.upgrade(request)
          } catch {
            throw new Response(null, { status: 403 })
          }
        },
      }
    },
  })
  Object.freeze(resolved)
}
/** Install synchronously in the open hook before any asynchronous admission.
 * This short-lived signalling protocol has no native ping heartbeat. Terminate
 * ping senders rather than queueing automatic replies outside the byte budget. */
export function installSignallingControlBounds(peer: unknown): void {
  if (
    !object(peer) ||
    !('_internal' in peer) ||
    !object(peer._internal) ||
    !('ws' in peer._internal) ||
    !object(peer._internal.ws)
  )
    throw new Error('Unsupported signalling native peer')
  const socket = peer._internal.ws
  if (
    !('_autoPong' in socket) ||
    socket._autoPong !== false ||
    !('on' in socket) ||
    typeof socket.on !== 'function' ||
    !('terminate' in socket) ||
    typeof socket.terminate !== 'function'
  )
    throw new Error('Native control reply policy unavailable')
  const terminate = socket.terminate.bind(socket)
  socket.on('ping', terminate)
}
/** Pinned CrossWS 0.3.5 NodeReqProxy. Unknown adapters fail closed; forwarded
 * URL/header representations never substitute for Node's original upgrade input. */
export function signallingNodeUpgrade(input: unknown): IncomingMessage {
  if (
    !object(input) ||
    !('_req' in input) ||
    !(input._req instanceof IncomingMessage)
  )
    throw new Error('Unsupported signalling upgrade adapter')
  return input._req
}
export function inspectSignallingUpgrade(
  input: unknown,
  role: SignallingSocketRole,
  configuredOrigin: string,
  mode: SignallingUpgradeMode = 'read-only',
): { request: IncomingMessage; headers: Headers; origin: string } {
  if (
    (role !== 'browser' && role !== 'connector') ||
    !Object.hasOwn(paths, mode)
  )
    throw new Error('Invalid signalling role')
  const origin = configuredAuthOrigin(configuredOrigin)
  const request = signallingNodeUpgrade(input)
  if (
    request.method !== 'GET' ||
    request.url !== paths[mode][role] ||
    ('originalUrl' in request && request.originalUrl !== request.url) ||
    request.rawHeaders.length > 64
  )
    throw new Error('Invalid signalling upgrade')
  const values = new Map<string, string>()
  let bytes = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase(),
      value = request.rawHeaders[index + 1]
    if (
      !name ||
      value === undefined ||
      values.has(name) ||
      /[\r\n\0]/.test(value)
    )
      throw new Error('Invalid signalling headers')
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
    if (bytes > 16384) throw new Error('Signalling header limit exceeded')
    values.set(name, value)
  }
  if (
    values.get('host') !== new URL(origin).host ||
    values.get('upgrade')?.toLowerCase() !== 'websocket' ||
    values.get('sec-websocket-version') !== '13' ||
    values.get('sec-websocket-protocol') !== subprotocols[mode] ||
    !/^[A-Za-z0-9+/]{21}[AQgw]==$/.test(values.get('sec-websocket-key') ?? '')
  )
    throw new Error('Invalid signalling handshake')
  const connection = values
    .get('connection')
    ?.toLowerCase()
    .split(',')
    .map((token) => token.trim())
  if (
    !connection?.includes('upgrade') ||
    connection.some((token) => !['upgrade', 'keep-alive'].includes(token))
  )
    throw new Error('Invalid upgrade connection')
  for (const forbidden of [
    'authorization',
    'content-type',
    'content-encoding',
    'content-length',
    'transfer-encoding',
  ])
    if (values.has(forbidden))
      throw new Error('Invalid signalling authentication carrier')
  if (role === 'browser') {
    if (
      !checkMutationOrigin(values.get('origin'), origin).ok ||
      !values.has('cookie')
    )
      throw new Error('Browser signalling authentication required')
    for (const [name, expected] of Object.entries({
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'websocket',
      'sec-fetch-dest': 'empty',
    }))
      if (values.has(name) && values.get(name) !== expected)
        throw new Error('Invalid browser fetch metadata')
  } else if (
    values.has('origin') ||
    values.has('cookie') ||
    [...values.keys()].some(
      (name) => name.startsWith('sec-fetch-') && name !== 'sec-fetch-mode',
    ) ||
    (values.has('sec-fetch-mode') &&
      values.get('sec-fetch-mode') !== 'websocket')
  )
    throw new Error('Machine signalling cannot use browser credentials')
  return { request, headers: new Headers([...values]), origin }
}
/** Only unseals our maintained host-only cookie; the caller still needs the
 * no-touch DB authority reader and fresh P-256 proof. No cookie is issued here. */
export async function signallingBrowserSession(
  input: unknown,
  configuredOrigin: string,
  cookie: SessionConfig,
  mode: SignallingUpgradeMode = 'read-only',
): Promise<{ request: IncomingMessage; sessionRecordId: string }> {
  const inspected = inspectSignallingUpgrade(
    input,
    'browser',
    configuredOrigin,
    mode,
  )
  const event = {
    req: new Request(inspected.origin + paths[mode].browser, {
      method: 'GET',
      headers: inspected.headers,
    }),
    res: { headers: new Headers() },
  }
  const sessionRecordId = await sealedSessionRecordId(event, { cookie })
  // Invalid/new cookies must never be returned as an upgrade authentication result.
  if (event.res.headers.has('set-cookie') || inspected.request.socket.destroyed)
    throw new Error('Invalid sealed signalling session')
  return { request: inspected.request, sessionRecordId }
}
