import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  PauseSignallingCoordinator,
  type PauseSignallingEndpoint,
  type PauseSignallingTimers,
} from '../../apps/farm/server/services/pause-signalling-coordinator.ts'
import {
  PauseNegotiationAuthority,
  PauseNegotiationScope,
} from '../../apps/farm/server/storage/postgres-pause-negotiation.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { signPauseTransportProof } from '../../packages/farm-protocol/src/pause-signalling.ts'
import {
  CredentialProofChallenge,
  CredentialProofCompletion,
  credentialProofPayload,
} from '../../packages/farm-protocol/src/credential-proof.ts'
import {
  ControlSessionBinding,
  controlSdpHash,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  base64url,
  decodeBase64url,
} from '../../packages/farm-protocol/src/encoding.ts'
import type { CredentialAcceptanceDecision } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import { connectorKeyBinding } from '../../apps/farm/server/utils/connector-credentials.ts'

class Clock implements PauseSignallingTimers {
  now = 100000
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
class Endpoint implements PauseSignallingEndpoint {
  readonly purpose = 'pause'
  closed = 0
  wires: string[] = []
  bindings: ControlSessionBinding[] = []
  onSend: (() => void) | undefined
  onBind: (() => void) | undefined
  onClose: (() => void) | undefined
  readonly clock: Clock
  constructor(clock: Clock) {
    this.clock = clock
  }
  armDeadline(ms: number, expired: () => void) {
    return this.clock.after(ms, expired)
  }
  send(wire: string) {
    assert.equal(this.closed, 0)
    this.wires.push(wire)
    this.onSend?.()
  }
  bindControl(binding: ControlSessionBinding) {
    assert.equal(this.closed, 0)
    this.bindings.push(binding)
    this.onBind?.()
  }
  close() {
    this.closed++
    this.onClose?.()
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const nonce = () => randomBytes(32).toString('base64url')
const flush = () => new Promise<void>((done) => setImmediate(done))
const sdp = (pin: string) =>
  'v=0\r\na=fingerprint:sha-256 ' + Array(32).fill(pin).join(':') + '\r\n'
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
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    browser.publicKey,
  )
  const publicBrowser = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const spki = base64url(
    new Uint8Array(await crypto.subtle.exportKey('spki', connector.publicKey)),
  )
  const ids = await connectorKeyBinding(spki)
  const scope = {
    sessionRecordId: 'actual-session-ref',
    farmId: randomUUID(),
    agentId: randomUUID(),
    keyId: randomUUID(),
    assignmentId: randomUUID(),
  }
  const authority = PauseNegotiationAuthority.parse({
    farm_id: scope.farmId,
    agent_id: scope.agentId,
    key_id: scope.keyId,
    assignment_id: scope.assignmentId,
    account_id: 'account-text',
    browser_public_key: publicBrowser.publicKey,
    browser_thumbprint: publicBrowser.thumbprint,
    connector_public_key_spki: spki,
    connector_fingerprint: ids.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example.test',
    audience: 'pause-audience',
    role: 'operator',
    validUntil: clock.now + 60000,
  })
  let printerKey = 'opaque printer',
    readCount = 0
  const defaultRead = async (_input: unknown) => {
    readCount++
    return {
      authority: structuredClone(authority),
      printerKey,
      budget: {
        observedAt: clock.now,
        validUntil: authority.validUntil,
        monotonicDeadline: authority.validUntil,
      },
    }
  }
  let read = defaultRead
  let issue: (input: unknown) => Promise<CredentialAcceptanceDecision> = async (
    input,
  ) => {
    const request = zRequest(input)
    return {
      ok: true,
      kind: 'challenge',
      challenge: CredentialProofChallenge.parse({
        v: 1,
        purpose: 'signalling',
        agent_id: request.agentId,
        farm_id: request.farmId,
        jti: authority.credential_jti,
        connection_id: request.connectionId,
        public_key_spki: spki,
        fingerprint: ids.fingerprint,
        thumbprint: ids.thumbprint,
        token_hash: createHash('sha256')
          .update(request.token)
          .digest('base64url'),
        origin: authority.origin,
        audience: 'credential-audience',
        generation: 7,
        nonce: nonce(),
        issued_at: clock.now,
        expires_at: clock.now + 8000,
      }),
    }
  }
  const coordinator = new PauseSignallingCoordinator({
    authority: { read: (input) => read(input) },
    credentials: {
      issue: (input) => issue(input),
      accept: async (input) => {
        const request = CredentialProofCompletion.parse(input)
        const good = await crypto.subtle.verify(
          'Ed25519',
          connector.publicKey,
          new Uint8Array(decodeBase64url(request.signature, 64)),
          new Uint8Array(credentialProofPayload(request.challenge)),
        )
        return good
          ? {
              ok: true,
              kind: 'accepted',
              agentId: request.agentId,
              farmId: request.farmId,
              jti: request.challenge.jti,
              connectionId: request.connectionId,
              purpose: 'signalling',
              acceptedAt: clock.now,
              expiresAt: request.challenge.expires_at,
            }
          : { ok: false, reason: 'denied' }
      },
    },
    credentialAudience: 'credential-audience',
    clock,
    timers: clock,
  })
  const browserEndpoint = new Endpoint(clock),
    connectorEndpoint = new Endpoint(clock)
  async function admit() {
    const opened = await coordinator.open(scope, browserEndpoint)
    assert.ok(opened)
    assert.equal(
      await coordinator.prove(
        opened.handle,
        await signPauseTransportProof(opened.challenge, browser.privateKey),
      ),
      true,
    )
    const attached = await coordinator.attachConnector(
      opened.handle,
      connectorEndpoint,
      'actual-token-test',
      { expiresAt: clock.now + 30000, monotonicDeadline: clock.now + 30000 },
    )
    assert.ok(attached?.kind === 'challenge')
    const sig = base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          connector.privateKey,
          new Uint8Array(credentialProofPayload(attached.challenge)),
        ),
      ),
    )
    assert.equal(await coordinator.prove(attached.handle, sig), true)
    return { opened, attached }
  }
  return {
    clock,
    browser,
    scope,
    authority,
    coordinator,
    browserEndpoint,
    connectorEndpoint,
    admit,
    defaultRead,
    readCount: () => readCount,
    setRead(value: typeof read) {
      read = value
    },
    setIssue(value: typeof issue) {
      issue = value
    },
    setPrinterKey(value: string) {
      printerKey = value
    },
  }
}
import { CredentialProofRequest } from '../../packages/farm-protocol/src/credential-proof.ts'
const zRequest = (input: unknown) => CredentialProofRequest.parse(input)

test('new pause context verifies actual browser/Connector signatures and builds exact server-owned control binding', async () => {
  const f = await fixture()
  const { opened, attached } = await f.admit()
  const before = f.coordinator.describe(opened.handle)
  assert.ok(before?.admitted)
  assert.equal(before.purpose, 'pause')
  assert.equal(before.bound, false)
  const offer = sdp('AA'),
    answer = sdp('BB')
  assert.equal(
    await f.coordinator.relay(
      attached.handle,
      JSON.stringify({
        v: 1,
        t: 'rtc.offer',
        transport_id: before.transportId,
        seq: 0,
        p: { sdp: offer },
      }),
    ),
    true,
  )
  assert.equal(
    await f.coordinator.relay(
      opened.handle,
      JSON.stringify({
        v: 1,
        t: 'rtc.answer',
        transport_id: before.transportId,
        seq: 0,
        p: { sdp: answer },
      }),
    ),
    true,
  )
  assert.equal(f.browserEndpoint.bindings.length, 1)
  assert.equal(f.connectorEndpoint.bindings.length, 1)
  const binding = f.browserEndpoint.bindings[0]!
  assert.deepEqual(binding, f.connectorEndpoint.bindings[0])
  assert.equal(binding.purpose, 'pause-rtc')
  assert.equal(binding.assignment_id, f.scope.assignmentId)
  assert.equal(binding.offer_sha256, await controlSdpHash(offer))
  assert.equal(binding.answer_sha256, await controlSdpHash(answer))
  assert.equal(binding.audience, 'pause-audience')
  assert.equal(attached.challenge.audience, 'credential-audience')
  assert.equal('commands_enabled' in binding, false)
  assert.equal('role' in binding, false)
  assert.equal('printerKey' in binding, false)
  assert.ok(binding.expires_at <= 130000)
  f.coordinator.dispose()
  assert.equal(f.browserEndpoint.closed, 1)
  assert.equal(f.connectorEndpoint.closed, 1)
  assert.equal(f.clock.tasks.size, 0)
})

test('changed assignment, role, credential and private printer metadata terminate instead of replacing binding', async () => {
  for (const change of ['assignment', 'role', 'credential', 'printer']) {
    const f = await fixture()
    const { opened, attached } = await f.admit()
    const id = f.coordinator.describe(opened.handle)!.transportId
    if (change === 'assignment') f.authority.assignment_id = randomUUID()
    if (change === 'role') f.authority.role = 'admin'
    if (change === 'credential') f.authority.credential_jti = randomUUID()
    if (change === 'printer') f.setPrinterKey('replacement')
    assert.equal(
      await f.coordinator.relay(
        attached.handle,
        JSON.stringify({
          v: 1,
          t: 'rtc.offer',
          transport_id: id,
          seq: 0,
          p: { sdp: sdp('AA') },
        }),
      ),
      false,
      change,
    )
    assert.equal(f.browserEndpoint.wires.length, 0)
    assert.equal(f.browserEndpoint.closed, 1)
    assert.equal(f.connectorEndpoint.closed, 1)
    f.coordinator.dispose()
  }
})

test('read deadline closes once while all eight real pending authority work slots remain held', async () => {
  const f = await fixture()
  const hold = deferred<Awaited<ReturnType<typeof f.defaultRead>>>()
  f.setRead(() => hold.promise)
  const endpoints = Array.from({ length: 9 }, () => new Endpoint(f.clock))
  const pending = endpoints
    .slice(0, 8)
    .map((endpoint) => f.coordinator.open(f.scope, endpoint))
  await flush()
  assert.equal(f.coordinator.snapshot().authorityTasks, 8)
  assert.equal(await f.coordinator.open(f.scope, endpoints[8]!), null)
  f.clock.advance(8000)
  assert.ok(endpoints.every((endpoint) => endpoint.closed === 1))
  assert.equal(f.coordinator.snapshot().authorityTasks, 8)
  assert.equal(f.coordinator.snapshot().allocating, 8)
  hold.resolve(await f.defaultRead(f.scope))
  assert.deepEqual(await Promise.all(pending), Array(8).fill(null))
  assert.equal(f.coordinator.snapshot().authorityTasks, 0)
  assert.equal(f.coordinator.snapshot().allocating, 0)
  f.coordinator.dispose()
  assert.ok(endpoints.every((endpoint) => endpoint.closed === 1))
})

test('terminal close during send or binding callback prevents every later callback', async () => {
  for (const moment of ['send', 'bind']) {
    const f = await fixture()
    const { opened, attached } = await f.admit()
    const id = f.coordinator.describe(opened.handle)!.transportId
    if (moment === 'send')
      f.browserEndpoint.onSend = () => f.coordinator.closeHandle(opened.handle)
    assert.equal(
      await f.coordinator.relay(
        attached.handle,
        JSON.stringify({
          v: 1,
          t: 'rtc.offer',
          transport_id: id,
          seq: 0,
          p: { sdp: sdp('AA') },
        }),
      ),
      moment !== 'send',
    )
    if (moment === 'bind') {
      f.browserEndpoint.onBind = () => f.coordinator.closeHandle(opened.handle)
      assert.equal(
        await f.coordinator.relay(
          opened.handle,
          JSON.stringify({
            v: 1,
            t: 'rtc.answer',
            transport_id: id,
            seq: 0,
            p: { sdp: sdp('BB') },
          }),
        ),
        false,
      )
      assert.equal(f.browserEndpoint.bindings.length, 1)
    }
    assert.equal(f.connectorEndpoint.bindings.length, 0)
    assert.equal(f.browserEndpoint.closed, 1)
    assert.equal(f.connectorEndpoint.closed, 1)
    f.coordinator.dispose()
  }
})

test('active relay remains charged through authority settlement, over-cap queue closes without orphan delivery', async () => {
  const f = await fixture()
  const { opened, attached } = await f.admit()
  const id = f.coordinator.describe(opened.handle)!.transportId
  const hold = deferred<Awaited<ReturnType<typeof f.defaultRead>>>()
  f.setRead(() => hold.promise)
  const makeWire = (seq: number) =>
    JSON.stringify({
      v: 1,
      t: 'rtc.offer',
      transport_id: id,
      seq,
      p: { sdp: sdp('AA') },
    })
  const calls = [0, 1, 2, 3].map((seq) =>
    f.coordinator.relay(attached.handle, makeWire(seq)),
  )
  await flush()
  assert.equal(f.coordinator.snapshot().authorityTasks, 1)
  assert.equal(await f.coordinator.relay(attached.handle, makeWire(4)), false)
  assert.equal(f.coordinator.snapshot().authorityTasks, 1)
  assert.equal(f.browserEndpoint.closed, 1)
  let settled = false
  void calls[0]!.then(() => {
    settled = true
  })
  await flush()
  assert.equal(settled, false)
  hold.resolve(await f.defaultRead(f.scope))
  assert.deepEqual(await Promise.all(calls), [false, false, false, false])
  assert.equal(f.coordinator.snapshot().authorityTasks, 0)
  assert.equal(f.browserEndpoint.wires.length, 0)
  f.coordinator.dispose()
})

test('fixed admission/lifetime never renew and bad direction, replay or command frames close', async () => {
  for (const mode of ['direction', 'replay', 'command', 'expiry']) {
    const f = await fixture()
    const { opened, attached } = await f.admit()
    const id = f.coordinator.describe(opened.handle)!.transportId
    const offer = JSON.stringify({
      v: 1,
      t: 'rtc.offer',
      transport_id: id,
      seq: 0,
      p: { sdp: sdp('AA') },
    })
    if (mode === 'replay')
      assert.equal(await f.coordinator.relay(attached.handle, offer), true)
    if (mode === 'expiry') f.clock.advance(30000)
    const result = await f.coordinator.relay(
      mode === 'direction' ? opened.handle : attached.handle,
      mode === 'command'
        ? JSON.stringify({ v: 1, t: 'control.command', wire: '{}' })
        : offer,
    )
    assert.equal(result, false)
    assert.equal(f.browserEndpoint.closed, 1)
    assert.equal(f.connectorEndpoint.closed, 1)
    f.coordinator.dispose()
    await flush()
  }
})

test('fresh credential work stays charged after disposal until the underlying promise settles', async () => {
  const f = await fixture()
  const opened = await f.coordinator.open(f.scope, f.browserEndpoint)
  assert.ok(opened)
  const hold = deferred<CredentialAcceptanceDecision>()
  f.setIssue(() => hold.promise)
  const pending = f.coordinator.attachConnector(
    opened.handle,
    f.connectorEndpoint,
    'token',
    { expiresAt: 130000, monotonicDeadline: 130000 },
  )
  await flush()
  assert.equal(f.coordinator.snapshot().cryptoTasks, 1)
  f.coordinator.dispose()
  assert.equal(f.coordinator.snapshot().cryptoTasks, 1)
  hold.resolve({ ok: false, reason: 'denied' })
  assert.equal(await pending, null)
  assert.equal(f.coordinator.snapshot().cryptoTasks, 0)
  assert.equal(f.browserEndpoint.closed, 1)
  assert.equal(f.connectorEndpoint.closed, 1)
})

test('eight-second admission never resets, while admitted negotiation retains only original thirty seconds', async () => {
  const unproved = await fixture()
  const opened = await unproved.coordinator.open(
    unproved.scope,
    unproved.browserEndpoint,
  )
  assert.ok(opened)
  unproved.clock.advance(7999)
  assert.ok(unproved.coordinator.describe(opened.handle))
  unproved.clock.advance(1)
  assert.equal(unproved.coordinator.describe(opened.handle), null)
  assert.equal(unproved.browserEndpoint.closed, 1)
  unproved.coordinator.dispose()
  await flush()
  const admitted = await fixture()
  const ready = await admitted.admit()
  const original = admitted.coordinator.describe(ready.opened.handle)
  assert.ok(original)
  admitted.clock.advance(8000)
  await flush()
  assert.ok(admitted.coordinator.describe(ready.opened.handle)?.admitted)
  assert.equal(
    await admitted.coordinator.relay(
      ready.attached.handle,
      JSON.stringify({
        v: 1,
        t: 'rtc.offer',
        transport_id: original.transportId,
        seq: 0,
        p: { sdp: sdp('AA') },
      }),
    ),
    true,
  )
  assert.equal(
    admitted.coordinator.describe(ready.opened.handle)?.expiresAt,
    original.expiresAt,
  )
  admitted.clock.advance(22000)
  await flush()
  assert.equal(admitted.coordinator.describe(ready.opened.handle), null)
  admitted.coordinator.dispose()
})

test('read-only protocol binding and proof frames cannot admit a pause peer', async () => {
  for (const t of ['rtc.binding', 'browser.proof']) {
    const f = await fixture()
    const { attached } = await f.admit()
    assert.equal(
      await f.coordinator.relay(
        attached.handle,
        JSON.stringify({
          v: 1,
          t,
          binding: { purpose: 'read-only-rtc', commands_enabled: false },
        }),
      ),
      false,
    )
    assert.equal(f.browserEndpoint.bindings.length, 0)
    assert.equal(f.connectorEndpoint.bindings.length, 0)
    assert.equal(f.browserEndpoint.closed, 1)
    f.coordinator.dispose()
  }
})

test('eight pending credential tasks retain capacity after terminal cleanup, ninth does not start', async () => {
  const f = await fixture()
  f.setRead(async (input) => {
    const scope = PauseNegotiationScope.parse(input)
    const snapshot = await f.defaultRead(input)
    return {
      ...snapshot,
      authority: {
        ...snapshot.authority,
        farm_id: scope.farmId,
        agent_id: scope.agentId,
        key_id: scope.keyId,
        assignment_id: scope.assignmentId,
      },
    }
  })
  const hold = deferred<CredentialAcceptanceDecision>()
  let calls = 0
  f.setIssue(() => {
    calls++
    return hold.promise
  })
  const pending = []
  const endpoints: Endpoint[] = []
  for (let index = 0; index < 9; index++) {
    const browser = new Endpoint(f.clock),
      connector = new Endpoint(f.clock)
    endpoints.push(browser, connector)
    const opened = await f.coordinator.open(
      { ...f.scope, agentId: randomUUID(), keyId: randomUUID() },
      browser,
    )
    assert.ok(opened)
    pending.push(
      f.coordinator.attachConnector(opened.handle, connector, 'token', {
        expiresAt: 130000,
        monotonicDeadline: 130000,
      }),
    )
  }
  await flush()
  assert.equal(calls, 8)
  assert.equal(f.coordinator.snapshot().cryptoTasks, 8)
  f.coordinator.dispose()
  assert.equal(f.coordinator.snapshot().cryptoTasks, 8)
  hold.resolve({ ok: false, reason: 'denied' })
  assert.deepEqual(await Promise.all(pending), Array(9).fill(null))
  assert.equal(f.coordinator.snapshot().cryptoTasks, 0)
  assert.ok(endpoints.every((endpoint) => endpoint.closed === 1))
})
