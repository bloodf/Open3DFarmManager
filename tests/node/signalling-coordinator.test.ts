import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import {
  SignallingCoordinator,
  type SignallingAuthority,
  type SignallingEndpoint,
  type SignallingTimers,
} from '../../apps/farm/server/services/signalling-coordinator.ts'
import {
  base64url,
  decodeBase64url,
} from '../../packages/farm-protocol/src/encoding.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { signBrowserTransportProof } from '../../packages/farm-protocol/src/browser-transport-proof.ts'
import {
  CredentialProofChallenge,
  CredentialProofCompletion,
  credentialProofPayload,
} from '../../packages/farm-protocol/src/credential-proof.ts'
import type { CredentialAcceptanceDecision } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import type { RtcSessionBinding } from '../../packages/farm-protocol/src/rtc-session-binding.ts'
class Clock implements SignallingTimers {
  now = 1000
  next = 0
  tasks = new Map<number, { at: number; callback: () => void }>()
  wall = () => this.now
  monotonic = () => this.now
  after(ms: number, callback: () => void) {
    const id = ++this.next
    this.tasks.set(id, { at: this.now + ms, callback })
    return () => {
      this.tasks.delete(id)
    }
  }
  advance(ms: number) {
    this.now += ms
    for (const [id, task] of [...this.tasks])
      if (task.at <= this.now) {
        this.tasks.delete(id)
        task.callback()
      }
  }
}
class Endpoint implements SignallingEndpoint {
  closed = 0
  wires: string[] = []
  bindings: RtcSessionBinding[] = []
  bound: Promise<void>
  private resolveBound: () => void = () => {}
  private clock: Clock
  constructor(clock: Clock) {
    this.clock = clock
    this.bound = new Promise((resolve) => {
      this.resolveBound = resolve
    })
  }
  armDeadline(ms: number, expired: () => void) {
    return this.clock.after(ms, expired)
  }
  send(wire: string) {
    assert.equal(this.closed, 0)
    this.wires.push(wire)
  }
  bindReadOnly(binding: RtcSessionBinding) {
    assert.equal(this.closed, 0)
    this.bindings.push(binding)
    this.resolveBound()
  }
  close() {
    this.closed++
  }
}
const nonce = () => base64url(randomBytes(32))
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
async function fixture() {
  const clock = new Clock()
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const browserKey = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const der = await crypto.subtle.exportKey('spki', connector.publicKey)
  const scope = {
    sessionRecordId: 'session_text',
    farmId: randomUUID(),
    agentId: randomUUID(),
    keyId: randomUUID(),
  }
  const authority: SignallingAuthority = {
    farm_id: scope.farmId,
    agent_id: scope.agentId,
    key_id: scope.keyId,
    account_id: 'account_text',
    browser_public_key: browserKey.publicKey,
    browser_thumbprint: browserKey.thumbprint,
    connector_public_key_spki: base64url(new Uint8Array(der)),
    connector_fingerprint:
      'SHA256:' +
      base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', der))),
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'test-farm',
    validUntil: 100000,
  }
  let current: SignallingAuthority | null = authority
  let read = async () => current
  let consumed = false
  const credentials = {
    async issue(input: unknown): Promise<CredentialAcceptanceDecision> {
      const request = CredentialProofCompletion.omit({
        challenge: true,
        signature: true,
      }).parse(input)
      return {
        ok: true,
        kind: 'challenge',
        challenge: CredentialProofChallenge.parse({
          v: 1,
          agent_id: scope.agentId,
          farm_id: scope.farmId,
          jti: authority.credential_jti,
          connection_id: request.connectionId,
          public_key_spki: authority.connector_public_key_spki,
          fingerprint: authority.connector_fingerprint,
          thumbprint: nonce(),
          token_hash: nonce(),
          origin: authority.origin,
          audience: authority.audience,
          purpose: 'signalling',
          generation: 1,
          nonce: nonce(),
          issued_at: clock.now,
          expires_at: clock.now + 60000,
        }),
      }
    },
    async accept(input: unknown): Promise<CredentialAcceptanceDecision> {
      const request = CredentialProofCompletion.parse(input)
      const valid = await crypto.subtle.verify(
        'Ed25519',
        connector.publicKey,
        new Uint8Array(decodeBase64url(request.signature, 64)),
        new Uint8Array(credentialProofPayload(request.challenge)),
      )
      if (consumed || !valid) return { ok: false, reason: 'denied' }
      consumed = true
      return {
        ok: true,
        kind: 'accepted',
        agentId: scope.agentId,
        farmId: scope.farmId,
        jti: authority.credential_jti,
        connectionId: request.connectionId,
        purpose: 'signalling',
        acceptedAt: clock.now,
        expiresAt: clock.now + 60000,
      }
    },
  }
  const coordinator = new SignallingCoordinator(
    {
      read: async () => {
        const value = await read()
        return value
          ? {
              authority: value,
              budget: {
                observedAt: clock.now,
                validUntil: value.validUntil,
                monotonicDeadline: value.validUntil,
              },
            }
          : null
      },
    },
    credentials,
    clock,
    clock,
  )
  const browserEndpoint = new Endpoint(clock),
    connectorEndpoint = new Endpoint(clock)
  const opened = await coordinator.open(scope, browserEndpoint)
  assert.ok(opened)
  const open = opened
  async function admit() {
    const attached = await coordinator.attachConnector(
      open.handle,
      connectorEndpoint,
      'synthetic-gateway-token',
      { expiresAt: clock.now + 30_000, monotonicDeadline: clock.now + 30_000 },
    )
    assert.ok(attached && attached.kind === 'challenge')
    assert.equal(
      await coordinator.prove(
        open.handle,
        await signBrowserTransportProof(open.challenge, browser.privateKey),
      ),
      true,
    )
    const signature = base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          connector.privateKey,
          new Uint8Array(credentialProofPayload(attached.challenge)),
        ),
      ),
    )
    assert.equal(await coordinator.prove(attached.handle, signature), true)
    return attached
  }
  return {
    coordinator,
    clock,
    scope,
    authority,
    open,
    browser,
    browserEndpoint,
    connectorEndpoint,
    admit,
    revoke: () => {
      current = null
    },
    change: (value: SignallingAuthority) => {
      current = value
    },
    setRead: (value: typeof read) => {
      read = value
    },
  }
}
const sdp = (hex: string) =>
  `v=0\r\na=fingerprint:sha-256 ${Array(32).fill(hex).join(':')}\r\n`
test('opaque handles and two real proofs admit only bounded metadata and exact read-only binding', async () => {
  const f = await fixture()
  try {
    assert.equal(f.coordinator.receive({}, '{}'), false)
    assert.equal(f.coordinator.receive(f.open.handle, '{}'), false)
    const connector = await f.admit()
    assert.equal(
      f.coordinator.receive(
        connector.handle,
        JSON.stringify({
          v: 1,
          transport_id: f.open.challenge.transport_id,
          seq: 0,
          t: 'rtc.offer',
          p: { sdp: sdp('AB') },
        }),
      ),
      true,
    )
    await flush()
    assert.equal(f.browserEndpoint.wires.length, 1)
    f.coordinator.receive(
      f.open.handle,
      JSON.stringify({
        v: 1,
        transport_id: f.open.challenge.transport_id,
        seq: 0,
        t: 'rtc.answer',
        p: { sdp: sdp('CD') },
      }),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        f.browserEndpoint.bound,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Binding did not complete')),
            1000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    assert.equal(f.browserEndpoint.bindings.length, 1)
    assert.deepEqual(f.browserEndpoint.bindings, f.connectorEndpoint.bindings)
    assert.equal(f.browserEndpoint.bindings[0]?.commands_enabled, false)
    assert.equal(f.browserEndpoint.bindings[0]?.expires_at, 31000)
    f.coordinator.receive(
      f.open.handle,
      JSON.stringify({
        v: 1,
        transport_id: f.open.challenge.transport_id,
        seq: 1,
        t: 'command',
        p: {},
      }),
    )
    await flush()
    assert.equal(f.browserEndpoint.closed, 1)
    assert.equal(f.connectorEndpoint.closed, 1)
  } finally {
    f.coordinator.dispose()
  }
  assert.equal(f.clock.tasks.size, 0)
})
test('fresh admission does not renew hard lifetime; local deadlines close without server revalidation', async () => {
  const f = await fixture()
  await f.admit()
  f.clock.advance(29999)
  await flush()
  assert.equal(f.browserEndpoint.closed, 0)
  f.clock.advance(1)
  assert.equal(f.browserEndpoint.closed, 1)
  assert.equal(f.connectorEndpoint.closed, 1)
  assert.equal(f.clock.tasks.size, 0)
  f.coordinator.dispose()
})
test('expired admission, revoked authority and clock regression close irreversibly', async () => {
  const expired = await fixture()
  expired.clock.advance(8000)
  assert.equal(
    await expired.coordinator.prove(
      expired.open.handle,
      await signBrowserTransportProof(
        expired.open.challenge,
        expired.browser.privateKey,
      ),
    ),
    false,
  )
  assert.equal(expired.browserEndpoint.closed, 1)
  expired.coordinator.dispose()
  const revoked = await fixture()
  const connector = await revoked.admit()
  revoked.revoke()
  revoked.coordinator.receive(
    connector.handle,
    JSON.stringify({
      v: 1,
      transport_id: revoked.open.challenge.transport_id,
      seq: 0,
      t: 'rtc.offer',
      p: { sdp: sdp('AB') },
    }),
  )
  await flush()
  assert.equal(revoked.browserEndpoint.wires.length, 0)
  assert.equal(revoked.browserEndpoint.closed, 1)
  revoked.coordinator.dispose()
  const regressed = await fixture()
  await regressed.admit()
  regressed.clock.now--
  assert.equal(
    regressed.coordinator.receive(regressed.open.handle, '{}'),
    false,
  )
  assert.equal(regressed.browserEndpoint.closed, 1)
  regressed.coordinator.dispose()
})
test('late authority callbacks cannot relay or reopen a context closed during asynchronous work', async () => {
  const f = await fixture()
  const connector = await f.admit()
  const pending: {
    finish: ((value: SignallingAuthority | null) => void) | null
  } = { finish: null }
  const delayed = new Promise<SignallingAuthority | null>((resolve) => {
    pending.finish = resolve
  })
  f.setRead(() => delayed)
  f.coordinator.receive(
    connector.handle,
    JSON.stringify({
      v: 1,
      transport_id: f.open.challenge.transport_id,
      seq: 0,
      t: 'rtc.offer',
      p: { sdp: sdp('AB') },
    }),
  )
  f.coordinator.disconnect(f.open.handle)
  const resolve = pending.finish
  assert.ok(resolve)
  resolve(f.authority)
  await flush()
  assert.equal(f.browserEndpoint.wires.length, 0)
  assert.equal(f.browserEndpoint.closed, 1)
  assert.equal(f.coordinator.receive(connector.handle, '{}'), false)
  assert.equal(f.clock.tasks.size, 0)
})
test('per-browser allocation and queued-byte limits fail closed and disposal releases timers', async () => {
  const f = await fixture()
  const second = await f.coordinator.open(f.scope, new Endpoint(f.clock))
  assert.ok(second)
  assert.equal(await f.coordinator.open(f.scope, new Endpoint(f.clock)), null)
  await f.admit()
  f.coordinator.receive(f.open.handle, ' '.repeat(8193))
  // Oversized data is rejected before queueing; it grants no authority.
  assert.equal(f.browserEndpoint.wires.length, 0)
  f.coordinator.dispose()
  assert.equal(f.clock.tasks.size, 0)
})
test('a stalled reader cannot accumulate unbounded queued frames or deliver a late offer', async () => {
  const f = await fixture()
  const connector = await f.admit()
  const pending: {
    finish: ((value: SignallingAuthority | null) => void) | null
  } = { finish: null }
  const delayed = new Promise<SignallingAuthority | null>((resolve) => {
    pending.finish = resolve
  })
  f.setRead(() => delayed)
  assert.equal(
    f.coordinator.receive(
      connector.handle,
      JSON.stringify({
        v: 1,
        transport_id: f.open.challenge.transport_id,
        seq: 0,
        t: 'rtc.offer',
        p: { sdp: sdp('AB') },
      }),
    ),
    true,
  )
  for (let i = 0; i < 3; i++)
    assert.equal(f.coordinator.receive(f.open.handle, ' '.repeat(8192)), true)
  assert.equal(f.coordinator.receive(f.open.handle, ' '.repeat(8192)), false)
  assert.equal(f.browserEndpoint.closed, 1)
  assert.ok(pending.finish)
  pending.finish(f.authority)
  await flush()
  assert.equal(f.browserEndpoint.wires.length, 0)
  assert.equal(f.clock.tasks.size, 0)
  f.coordinator.dispose()
})
test('bad browser signature burns only its ephemeral context; passive key changes close an admitted context', async () => {
  const f = await fixture()
  assert.equal(
    await f.coordinator.prove(f.open.handle, base64url(randomBytes(64))),
    false,
  )
  assert.equal(f.browserEndpoint.closed, 1)
  assert.equal(
    await f.coordinator.prove(
      f.open.handle,
      await signBrowserTransportProof(f.open.challenge, f.browser.privateKey),
    ),
    false,
  )
  f.coordinator.dispose()
  const current = await fixture()
  await current.admit()
  current.change({ ...current.authority, credential_jti: randomUUID() })
  current.clock.advance(5000)
  await flush()
  assert.equal(current.browserEndpoint.closed, 1)
  assert.equal(current.connectorEndpoint.closed, 1)
  assert.equal(current.clock.tasks.size, 0)
  current.coordinator.dispose()
})
test('initial authority-read expiry and disposal close endpoints before late admission results', async () => {
  for (const dispose of [false, true]) {
    const f = await fixture()
    const endpoint = new Endpoint(f.clock)
    const pending: {
      finish: ((value: SignallingAuthority | null) => void) | null
    } = { finish: null }
    const delayed = new Promise<SignallingAuthority | null>((resolve) => {
      pending.finish = resolve
    })
    f.setRead(() => delayed)
    const opening = f.coordinator.open(f.scope, endpoint)
    if (dispose) f.coordinator.dispose()
    else f.clock.advance(8000)
    assert.equal(endpoint.closed, 1)
    assert.ok(pending.finish)
    pending.finish(f.authority)
    assert.equal(await opening, null)
    f.coordinator.dispose()
    assert.equal(f.clock.tasks.size, 0)
  }
})
