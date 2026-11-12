import type { MoonrakerLimits } from '../config/moonraker.ts'

// Set before module evaluation. Do not statically import ws or enable addons.
process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'
const { default: WebSocket } = await import('ws')

// The ws receiver enforces payload/fragment/chunk bounds before message dispatch.
// Compression, redirects and optional native addons are disabled.
export function createMoonrakerSocket(
  origin: string,
  limits: MoonrakerLimits,
  extra: { allowSynchronousEvents?: boolean } = {},
) {
  const url = new URL('/websocket', origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(url, {
    maxPayload: limits.maxMessageBytes,
    maxFragments: 128,
    maxBufferedChunks: 128,
    ...extra,
    perMessageDeflate: false,
    followRedirects: false,
    handshakeTimeout: limits.connectTimeoutMs,
    skipUTF8Validation: false,
  })
}
