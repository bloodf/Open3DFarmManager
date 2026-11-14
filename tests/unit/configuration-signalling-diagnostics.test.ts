import { describe, expect, it } from 'vitest'
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import { encodeConfigurationSignallingServerFrame } from '../../packages/farm-protocol/src/configuration-signalling.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import type { ConfigurationRuntime } from '../../packages/connector/src/runtime/configuration.ts'
import type { ConfigurationConnectorSession } from '../../packages/connector/src/webrtc/configuration-session.ts'
import {
  createConfigurationSignallingClient,
  type ConfigurationPeerFactory,
  type ConfigurationSocket,
} from '../../packages/connector/src/webrtc/configuration-signalling.ts'

const FARM_ORIGIN = 'https://farm.example.com'
const AUDIENCE = 'open3dfarm/connector'
const T0 = 1_800_000_000_000
const TOKEN = 'secret-header.secret-payload.secret-signature'
const LEAK = 'leaked-detail-must-not-appear'
const nonce = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

type Failure = 'scope' | 'window' | 'expired' | 'session' | 'offer'
type DiagnosticMode = 'record' | 'throw' | 'reject'

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

/** Drives one real signalling client through proof and a failing context. */
async function drive(failure: Failure, mode: DiagnosticMode) {
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
  let revocations = 0
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
  const sessions: { closed: boolean }[] = []
  const runtime = {
    revision: () => 0,
    revokeAll: () => {
      revocations++
    },
    openSession: () => {
      if (failure === 'session')
        throw new Error(`Configuration session unavailable ${TOKEN} ${LEAK}`)
      const state = { closed: false }
      sessions.push(state)
      return {
        closed: new Promise<void>(() => {}),
        close: () => {
          state.closed = true
        },
      } as unknown as ConfigurationConnectorSession
    },
  } as unknown as ConfigurationRuntime
  const peer: ConfigurationPeerFactory = (input) => {
    const session = input.session(() => {})
    return {
      session,
      closed: new Promise<void>(() => {}),
      offer: async () => {
        if (failure === 'offer')
          throw new TypeError(`${FARM_ORIGIN}/${ids.account} ${LEAK}`)
        return 'v=0'
      },
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
      if (mode === 'throw') throw new Error(`observer failed ${TOKEN}`)
      if (mode === 'reject')
        return Promise.reject(new Error(`observer failed ${TOKEN}`)) as never
    },
  })
  const controller = new AbortController()
  const running = client.run(controller.signal)
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++)
      await new Promise((resolve) => setTimeout(resolve, 2))
  }
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
  const onlineBeforeContext = client.online()
  const browser = await browserKey()
  serve({
    v: 1,
    t: 'config.context-request',
    transport_id: randomUUID(),
    farm_id: failure === 'scope' ? randomUUID() : ids.farm,
    agent_id: ids.agent,
    key_id: ids.key,
    account_id: ids.account,
    browser_public_key: browser.publicKey,
    browser_thumbprint: browser.thumbprint,
    connector_nonce: nonce(),
    issued_at:
      failure === 'window'
        ? T0 + 5_007
        : failure === 'expired'
          ? T0 - 30_000
          : T0,
    expires_at: failure === 'expired' ? T0 - 3 : T0 + 30_000,
  })
  await until(() => socketCloses > 0)
  const outcome = {
    sent: sent.map((frame) => frame.t),
    socketCloses,
    revocations,
    onlineBeforeContext,
    onlineAfter: client.online(),
    openSessions: sessions.filter((s) => !s.closed).length,
  }
  controller.abort()
  await running
  return {
    outcome,
    diagnostics,
    secrets: [TOKEN, LEAK, FARM_ORIGIN, ...Object.values(ids)],
  }
}

const EXPECTED_STAGE: Record<
  Failure,
  { stage: string; error: string; window?: string; windowMs?: number }
> = {
  scope: { stage: 'context-scope', error: 'Error' },
  // Context issued beyond the 5000 ms skew bound: a future lease.
  window: {
    stage: 'context-window',
    error: 'Error',
    window: 'future',
    windowMs: 5_007,
  },
  // Context that ended 3 ms before the Connector clock: an expired lease.
  expired: {
    stage: 'context-window',
    error: 'Error',
    window: 'expired',
    windowMs: 3,
  },
  session: { stage: 'context-session', error: 'Error' },
  offer: { stage: 'context-offer', error: 'TypeError' },
}

describe('configuration signalling: fixed failure-stage diagnostics', () => {
  it.each(Object.keys(EXPECTED_STAGE) as Failure[])(
    'reports the %s context failure stage as fixed categories only',
    async (failure) => {
      const { outcome, diagnostics, secrets } = await drive(failure, 'record')
      expect(outcome).toEqual({
        sent: [
          'config.connector-begin',
          'config.connector-proof',
          'config.advertise',
        ],
        socketCloses: 1,
        revocations: 1,
        onlineBeforeContext: true,
        onlineAfter: false,
        openSessions: 0,
      })
      const failed = diagnostics.filter((d) => d.state === 'frame-failed')
      expect(failed).toEqual([
        {
          kind: 'configuration-signalling',
          state: 'frame-failed',
          frame: 'config.context-request',
          ...EXPECTED_STAGE[failure],
        },
      ])
      const wire = JSON.stringify(diagnostics)
      for (const secret of secrets) expect(wire).not.toContain(secret)
      expect(wire).not.toContain('session unavailable')
      expect(wire).not.toContain('Foreign')
    },
  )

  it.each(['throw', 'reject'] as const)(
    'a diagnostic callback that %ss cannot change the refusal outcome',
    async (mode) => {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        for (const failure of Object.keys(EXPECTED_STAGE) as Failure[]) {
          const baseline = await drive(failure, 'record')
          const observed = await drive(failure, mode)
          expect(observed.outcome).toEqual(baseline.outcome)
          expect(
            observed.diagnostics.filter((d) => d.state === 'frame-failed'),
          ).toEqual(
            baseline.diagnostics.filter((d) => d.state === 'frame-failed'),
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    },
  )

  it('reports a malformed frame before decoding without echoing it', async () => {
    const identity = new ConnectorIdentity(
      generateKeyPairSync('ed25519').privateKey,
    )
    const diagnostics: Record<string, unknown>[] = []
    let handlers: { message(raw: unknown): void; close(): void } | undefined
    let closes = 0
    const client = createConfigurationSignallingClient({
      identity,
      farmOrigin: FARM_ORIGIN,
      credentialAudience: AUDIENCE,
      farmId: randomUUID(),
      agentId: randomUUID(),
      credential: () => ({ token: TOKEN, jti: randomUUID() }),
      runtime: () => {
        throw new Error('unused')
      },
      socket: async () => ({
        send: () => {},
        close: () => {
          closes++
          handlers?.close()
        },
        bind: (h) => {
          handlers = h
        },
      }),
      clock: () => T0,
      retryMinMs: 60_000,
      onDiagnostic: (event) => diagnostics.push({ ...event }),
    })
    const controller = new AbortController()
    const running = client.run(controller.signal)
    for (let i = 0; i < 200 && !handlers; i++)
      await new Promise((resolve) => setTimeout(resolve, 2))
    handlers?.message(`{"t":"${LEAK}"}`)
    for (let i = 0; i < 200 && closes === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 2))
    controller.abort()
    await running
    expect(closes).toBe(1)
    const failed = diagnostics.filter((d) => d.state === 'frame-failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ stage: 'frame-decode', frame: null })
    expect(JSON.stringify(diagnostics)).not.toContain(LEAK)
  })
})
