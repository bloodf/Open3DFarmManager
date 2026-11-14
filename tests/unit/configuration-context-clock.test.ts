import { describe, expect, it } from 'vitest'
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import { CONFIGURATION_HARD_MAXIMUMS } from '../../packages/farm-protocol/src/configuration-common.ts'
import { encodeConfigurationSignallingServerFrame } from '../../packages/farm-protocol/src/configuration-signalling.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import type { ConfigurationRuntime } from '../../packages/connector/src/runtime/configuration.ts'
import type { ConfigurationConnectorSession } from '../../packages/connector/src/webrtc/configuration-session.ts'
import {
  createConfigurationSignallingClient,
  type ConfigurationPeerFactory,
  type ConfigurationSocket,
} from '../../packages/connector/src/webrtc/configuration-signalling.ts'

/**
 * The farm stamps a context lease from its database clock while the Connector
 * judges it with its own wall clock. Run 620bba9c refused every context whose
 * database `issued_at` was a few milliseconds ahead of the Connector clock.
 * These tests drive the real signalling client handler: a not-before inside
 * the published skew bound opens the context, anything beyond it or at/after
 * expiry is refused, and the lease deadline is never extended.
 */
const FARM_ORIGIN = 'https://farm.example.com'
const AUDIENCE = 'open3dfarm/connector'
const T0 = 1_800_000_000_000
const TOKEN = 'secret-header.secret-payload.secret-signature'
const SKEW = CONFIGURATION_HARD_MAXIMUMS.skewMs
const DTLS = Array.from({ length: 32 }, () => 'AB').join(':')
const SDP = `v=0\r\na=fingerprint:sha-256 ${DTLS}\r\na=setup:actpass\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`
const nonce = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

async function browserKey() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const publicKey = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } as const
  const thumbprint = base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalize(publicKey)),
      ),
    ),
  )
  return { publicKey, thumbprint }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 2))
}

/**
 * Proves one real client online at T0, then serves a context lease with the
 * given `issued_at`/`expires_at` offsets from the Connector clock.
 */
async function drive(lease: { issuedAt: number; expiresAt: number }) {
  const ids = {
    farm: randomUUID(),
    agent: randomUUID(),
    key: randomUUID(),
    jti: randomUUID(),
    account: `account_${randomUUID()}`,
  }
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const sent: Record<string, unknown>[] = []
  const diagnostics: Record<string, unknown>[] = []
  let handlers: { message(raw: unknown): void; close(): void } | undefined
  let socketCloses = 0
  const socket: ConfigurationSocket = {
    send: (wire) => sent.push(JSON.parse(wire) as Record<string, unknown>),
    close: () => {
      socketCloses++
      handlers?.close()
    },
    bind: (h) => {
      handlers = h
    },
  }
  const sessions: { closed: boolean; reason?: string | undefined }[] = []
  const runtime = {
    revision: () => 0,
    revokeAll: () => {},
    openSession: () => {
      const state: { closed: boolean; reason?: string | undefined } = {
        closed: false,
      }
      sessions.push(state)
      return {
        closed: new Promise<void>(() => {}),
        close: (reason?: string) => {
          state.closed = true
          state.reason = reason
        },
      } as unknown as ConfigurationConnectorSession
    },
  } as unknown as ConfigurationRuntime
  const peer: ConfigurationPeerFactory = (input) => {
    const session = input.session(() => {})
    return {
      session,
      closed: new Promise<void>(() => {}),
      offer: async () => SDP,
      answer: () => {},
      close: (reason) => session.close(reason),
    }
  }
  const client = createConfigurationSignallingClient({
    identity,
    farmOrigin: FARM_ORIGIN,
    credentialAudience: AUDIENCE,
    farmId: ids.farm,
    agentId: ids.agent,
    credential: () => ({ token: TOKEN, jti: ids.jti }),
    runtime: () => runtime,
    socket: async () => socket,
    peer,
    clock: () => T0,
    retryMinMs: 60_000,
    onDiagnostic: (event) => {
      diagnostics.push({ ...event })
    },
  })
  const controller = new AbortController()
  const running = client.run(controller.signal)
  const serve = (frame: unknown) =>
    handlers?.message(encodeConfigurationSignallingServerFrame(frame))
  await until(() => sent.length > 0)
  const jwk = createPublicKey({
    key: Buffer.from(identity.publicKeySpki, 'base64url'),
    format: 'der',
    type: 'spki',
  }).export({ format: 'jwk' })
  const challenge = {
    v: 1,
    agent_id: ids.agent,
    farm_id: ids.farm,
    jti: ids.jti,
    connection_id: randomUUID(),
    public_key_spki: identity.publicKeySpki,
    fingerprint: identity.fingerprint,
    thumbprint: createHash('sha256')
      .update(canonicalize({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }))
      .digest('base64url'),
    token_hash: createHash('sha256').update(TOKEN).digest('base64url'),
    origin: FARM_ORIGIN,
    audience: AUDIENCE,
    purpose: 'signalling',
    generation: 1,
    nonce: nonce(),
    issued_at: T0,
    expires_at: T0 + 30_000,
  }
  serve({ v: 1, t: 'config.connector-challenge', challenge })
  await until(() => sent.length > 1)
  serve({
    v: 1,
    t: 'config.connector-ready',
    inbox_id: challenge.connection_id,
    issued_at: T0,
    expires_at: T0 + 60_000,
  })
  await until(() => client.online())
  const browser = await browserKey()
  const transportId = randomUUID()
  serve({
    v: 1,
    t: 'config.context-request',
    transport_id: transportId,
    farm_id: ids.farm,
    agent_id: ids.agent,
    key_id: ids.key,
    account_id: ids.account,
    browser_public_key: browser.publicKey,
    browser_thumbprint: browser.thumbprint,
    connector_nonce: nonce(),
    issued_at: T0 + lease.issuedAt,
    expires_at: T0 + lease.expiresAt,
  })
  await until(
    () => socketCloses > 0 || sent.some((frame) => frame.t === 'rtc.offer'),
  )
  const snapshot = () => ({
    sent: sent.map((frame) => frame.t),
    offerTransport:
      sent.find((frame) => frame.t === 'rtc.offer')?.transport_id ?? null,
    socketCloses,
    online: client.online(),
    sessions: sessions.map((s) => ({ ...s })),
    failed: diagnostics.filter((d) => d.state === 'frame-failed'),
  })
  const before = snapshot()
  controller.abort()
  await running
  return { before, after: snapshot(), transportId }
}

const OPENED = [
  'config.connector-begin',
  'config.connector-proof',
  'config.advertise',
  'rtc.offer',
]
const REFUSED = [
  'config.connector-begin',
  'config.connector-proof',
  'config.advertise',
]

describe('configuration context lease: database/Connector clock skew', () => {
  it.each([1, 4, 71, SKEW])(
    'opens a context whose database not-before is %i ms ahead of the Connector clock',
    async (ahead) => {
      const { before, transportId } = await drive({
        issuedAt: ahead,
        expiresAt: ahead + 9_000,
      })
      expect(before.failed).toEqual([])
      expect(before.sent).toEqual(OPENED)
      expect(before.offerTransport).toBe(transportId)
      expect(before.socketCloses).toBe(0)
      expect(before.online).toBe(true)
      expect(before.sessions).toEqual([{ closed: false }])
    },
  )

  it.each([SKEW + 1, SKEW + 7, 60_000])(
    'refuses a context whose not-before is %i ms ahead, beyond the published skew',
    async (ahead) => {
      const { before } = await drive({
        issuedAt: ahead,
        expiresAt: ahead + 9_000,
      })
      expect(before.sent).toEqual(REFUSED)
      expect(before.socketCloses).toBe(1)
      expect(before.online).toBe(false)
      expect(before.sessions).toEqual([])
      expect(before.failed).toEqual([
        {
          kind: 'configuration-signalling',
          state: 'frame-failed',
          stage: 'context-window',
          frame: 'config.context-request',
          error: 'Error',
          window: 'future',
          windowMs: ahead,
        },
      ])
    },
  )

  it.each([
    ['at the expiry instant', -9_000, 0, 0],
    ['1 ms after expiry', -9_000, -1, 1],
    ['long after expiry, even inside the skew bound', -9_000, -4_000, 4_000],
  ])(
    'refuses a context %s: the skew never extends expires_at',
    async (_label, issuedAt, expiresAt, windowMs) => {
      const { before } = await drive({ issuedAt, expiresAt })
      expect(before.sent).toEqual(REFUSED)
      expect(before.socketCloses).toBe(1)
      expect(before.online).toBe(false)
      expect(before.sessions).toEqual([])
      expect(before.failed).toEqual([
        {
          kind: 'configuration-signalling',
          state: 'frame-failed',
          stage: 'context-window',
          frame: 'config.context-request',
          error: 'Error',
          window: 'expired',
          windowMs,
        },
      ])
    },
  )

  it('closes a skew-admitted context and its session when the client is aborted', async () => {
    const { before, after } = await drive({ issuedAt: 4, expiresAt: 9_004 })
    expect(before.sessions).toEqual([{ closed: false }])
    expect(after.online).toBe(false)
    expect(after.sessions).toHaveLength(1)
    expect(after.sessions[0]!.closed).toBe(true)
    expect(after.sent).toEqual(OPENED)
  })
})
