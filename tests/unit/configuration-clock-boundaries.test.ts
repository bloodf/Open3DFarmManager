import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import {
  deriveConfigurationAssignmentIdentity,
  signConfigurationInventoryAck,
  verifyConfigurationInventoryAck,
  ConfigurationInventoryExpectation,
} from '../../packages/farm-protocol/src/configuration-inventory.ts'

const uuid = '00000000-0000-4000-8000-000000000001'
const digest = 'A'.repeat(43)
const stable = {
  account_id: 'owner',
  farm_id: uuid,
  agent_id: uuid,
  bridge_instance_id: 'bridge-1',
  device_id: 'device-1',
}
async function fixture() {
  const keys = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const identity = await deriveConfigurationAssignmentIdentity(stable)
  const claims = {
    v: 1,
    protocol: 'config-v1',
    purpose: 'configuration-inventory-ack',
    context: {
      account_id: 'owner',
      farm_id: uuid,
      agent_id: uuid,
      key_id: uuid,
      transport_id: uuid,
      browser_thumbprint: digest,
      connector_fingerprint: 'SHA256:' + digest,
      credential_jti: uuid,
      configuration_binding_sha256: digest,
      origin: 'https://farm.example',
      audience: 'https://farm.example',
    },
    kid: 'issuer-1',
    issuer: 'https://farm.example',
    operation_id: uuid,
    committed_receipt_sha256: digest,
    committed_revision: 1,
    ...identity,
    nonce: digest,
    issued_at: 10000,
    expires_at: 40000,
  }
  const { v, protocol, purpose, nonce, issued_at, expires_at, ...expected } =
    claims
  return {
    keys,
    claims,
    expected: ConfigurationInventoryExpectation.parse(expected),
    ack: await signConfigurationInventoryAck(claims, keys.privateKey),
  }
}

// Actor/clock census (source behavior only):
// DB configuration authority -> browser challenge/capability: Date.now, 5000 ms.
// DB binding/challenge -> DB authority: transaction now, strict persisted checks.
// DB context -> Connector signalling: local clock, published 5000 ms (context-clock suite).
// Binding -> Connector session/authority validator: local clock, configured 2000 default,
// capped at 5000; browser peer retains 2000 ms.
// Host session timestamps -> PostgresConfigurationStore: host clock (session-clock suite).
// Connector receipt -> DB registration: DB now, published 5000 ms both directions.
// DB inventory acknowledgement -> browser Date.now / Connector clock: shared verifier.
// Host credential challenge -> Connector validChallenge: published 5000 ms not-before skew.
// Host connector-ready -> Connector signalling: published 5000 ms.
// Proof TTL 10000, minimum context 5000 and monotonic deadlines are unchanged.
it.each([1, 97, 5000])(
  'accepts a signed DB ack %i ms ahead of either consumer',
  async (ahead) => {
    const { ack, keys, expected } = await fixture()
    expect(
      await verifyConfigurationInventoryAck(
        ack,
        keys.publicKey,
        expected,
        ack.issued_at - ahead,
      ),
    ).toBe(true)
  },
)
it.each([4999, 40000, 40001])(
  'refuses an ack outside its bounded window at %i',
  async (now) => {
    const { ack, keys, expected } = await fixture()
    expect(
      await verifyConfigurationInventoryAck(ack, keys.publicKey, expected, now),
    ).toBe(false)
  },
)

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto'

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
async function drive(lease: {
  issuedAt: number
  expiresAt: number
  challengeAhead?: number
  challengeExpiry?: number
}) {
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
    issued_at: T0 + (lease.challengeAhead ?? 0),
    expires_at: T0 + (lease.challengeExpiry ?? 30_000),
  }
  const proofInput = {
    challenge,
    token: TOKEN,
    expectedOrigin: FARM_ORIGIN,
    expectedAudience: AUDIENCE,
    expectedPurpose: 'signalling' as const,
    expectedConnectionId: challenge.connection_id,
    now: T0,
  }
  if ((lease.challengeAhead ?? 0) > 0)
    expect(() => identity.signCredentialProof(proofInput)).toThrow()
  for (const notBeforeSkewMs of [-1, 0.5, NaN, Infinity, 5001])
    expect(() =>
      identity.signCredentialProof({ ...proofInput, notBeforeSkewMs }),
    ).toThrow()
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

it.each([0, 1, 97, 5000, 5001])(
  'censuses Host credential challenge at +%i ms through real Connector handler',
  async (challengeAhead) => {
    const { before } = await drive({
      issuedAt: 0,
      expiresAt: 9000,
      challengeAhead,
    })
    expect(before.sent.includes('config.connector-proof')).toBe(
      challengeAhead <= 5000,
    )
    expect(before.socketCloses).toBe(challengeAhead <= 5000 ? 0 : 1)
  },
)

// These source checks make the actor census rerunnable; behavioral evidence is
// the real ack verifier and signalling handler above, plus the existing
// configuration-contract, context-clock and session-clock suites in the gate.
it.each([
  [
    'browser challenge/capability',
    'apps/farm/app/utils/kobralink-onboarding.ts',
    [
      'configurationFresh(challenge, Date.now(), 5000)',
      'configurationFresh(capability, Date.now(), 5000)',
      'verifyConfigurationInventoryAck(',
    ],
  ],
  [
    'browser binding',
    'apps/farm/app/utils/webrtc/configuration-browser-peer.ts',
    ['configurationFresh(this.#binding, this.#clock(), 2000)'],
  ],
  [
    'persisted DB authority',
    'apps/farm/server/services/configuration-authority.ts',
    [
      'configurationFresh(binding, now)',
      'configurationFresh(stored.challenge, now)',
      'issued_at: now',
    ],
  ],
  [
    'Connector session',
    'packages/connector/src/webrtc/configuration-session.ts',
    [
      'options.clock ?? Date.now',
      'this.#options.skewMs ?? 2000',
      'skewMs: this.skew()',
    ],
  ],
  [
    'receipt and ack producer',
    'apps/farm/server/services/configuration-receipt-registration.ts',
    [
      'op.created_at - CONFIGURATION_HARD_MAXIMUMS.skewMs',
      'now + CONFIGURATION_HARD_MAXIMUMS.skewMs',
      'signConfigurationInventoryAck(',
      'issued_at: now',
    ],
  ],
  [
    'Connector ack consumer',
    'packages/connector/src/runtime/configuration-authority.ts',
    [
      'options.clock ?? Date.now',
      'verifyConfigurationInventoryAck(',
      'await isCurrent(context)',
    ],
  ],
  [
    'host credential producer',
    'apps/farm/server/storage/postgres-connector-credential-acceptance.ts',
    ['clock: () => number = Date.now', 'issued_at: verifiedAt'],
  ],
  [
    'Connector credential validator',
    'packages/connector/src/identity/credential-proof.ts',
    [
      'input.now < challenge.issued_at - skew',
      'input.now >= challenge.expires_at',
    ],
  ],
] as const)(
  'records %s clock policy at its actual caller',
  (_actor, path, policies) => {
    const source = readFileSync(
      new URL('../../' + path, import.meta.url),
      'utf8',
    )
    for (const policy of policies) expect(source).toContain(policy)
  },
)

it.each([0, -1])(
  'refuses challenge expiry offset %i in actual handler',
  async (challengeExpiry) => {
    const { before } = await drive({
      issuedAt: 0,
      expiresAt: 9000,
      challengeAhead: -10000,
      challengeExpiry,
    })
    expect(before.sent).not.toContain('config.connector-proof')
    expect(before.socketCloses).toBe(1)
  },
)
