import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  API_ENVELOPE_ISSUER,
  API_ENVELOPE_CLOCK_SKEW_MS,
  MAX_API_ENVELOPE_FILE_URL_CHARS,
  MAX_API_ENVELOPE_TTL_MS,
  MAX_API_ENVELOPE_WIRE_BYTES,
  MIN_API_ENVELOPE_TTL_MS,
  ApiEnvelopeV1,
  SignedApiEnvelopeV1,
  decodeApiEnvelopeFrame,
  decodeApiEnvelopeResultFrame,
  encodeApiEnvelopeFrame,
  encodeApiEnvelopeResultFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
  verifyApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  signTrustedKeySet,
  verifyTrustedKeySet,
} from '../../packages/farm-protocol/src/trusted-keys.ts'
import {
  IntegrationDeliveryService,
  requiredScopeFor,
  type EnvelopeInbox,
  type EnvelopeRecord,
  type EnvelopeResult,
  type EnvelopeStatus,
  type InsertOutcome,
  type IntegrationDeliveryStore,
  type NewEnvelope,
} from '../../apps/farm/server/services/integration-delivery.ts'
import {
  IntegrationAuditService,
  type IntegrationAuditEntry,
  type IntegrationAuditStore,
} from '../../apps/farm/server/services/integration-audit.ts'

const NOW = 1_800_000_000_000
const FARM = '22222222-2222-4222-8222-222222222222'
const OTHER_FARM = '33333333-3333-4333-8333-333333333333'
const AGENT = '44444444-4444-4444-8444-444444444444'
const OTHER_AGENT = '55555555-5555-4555-8555-555555555555'
const APP = '66666666-6666-4666-8666-666666666666'
const GRANT = '77777777-7777-4777-8777-777777777777'
const ASSIGNMENT = '88888888-8888-4888-8888-888888888888'
const spkiOf = async (key: CryptoKey) =>
  Buffer.from(await crypto.subtle.exportKey('spki', key)).toString('base64url')
const issuerPair = () =>
  crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])

const jobCommand = {
  kind: 'job' as const,
  job: {
    file_url: 'https://files.example.invalid/benchy.gcode',
    sha256: 'a'.repeat(64),
    size_bytes: 1234,
    display_name: 'benchy.gcode',
  },
}
const pauseCommand = {
  kind: 'action' as const,
  action: { action: 'pause' as const, args: {} },
}
const claims = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  purpose: 'api-envelope',
  issuer: API_ENVELOPE_ISSUER,
  kid: 'api-1',
  app_id: APP,
  grant_id: GRANT,
  farm_id: FARM,
  agent_id: AGENT,
  assignment_id: ASSIGNMENT,
  resource_id: randomUUID(),
  cmd_id: randomUUID(),
  nonce: newApiEnvelopeNonce(),
  issued_at: NOW,
  expires_at: NOW + 60_000,
  ...jobCommand,
  ...extra,
})

test('envelope schema accepts a job and an action and rejects everything else', () => {
  assert.ok(ApiEnvelopeV1.safeParse(claims()).success)
  const action = claims({ ...pauseCommand, job: undefined })
  delete (action as Record<string, unknown>).job
  assert.ok(ApiEnvelopeV1.safeParse(action).success)
  assert.ok(
    ApiEnvelopeV1.safeParse({
      ...action,
      action: { action: 'emergency_stop', args: {} },
    }).success,
  )
  assert.equal(
    requiredScopeFor({
      kind: 'action',
      action: { action: 'emergency_stop', args: {} },
    }),
    'control:emergency',
  )
  const bad = (extra: Record<string, unknown>) =>
    assert.equal(ApiEnvelopeV1.safeParse(claims(extra)).success, false)
  bad({ extra: 1 })
  bad({ issuer: 'open3dfarm:trusted-key-issuer' })
  bad({ purpose: 'trusted-key-set' })
  bad({ farm_id: 'not-a-uuid' })
  bad({ nonce: 'short' })
  bad({ kind: 'action' }) // job payload on an action
  bad({ ...pauseCommand }) // both payloads
  bad({ job: undefined }) // job without payload
  bad({ job: { ...jobCommand.job, extra: true } })
  for (const action of [
    { action: 'emergency_stop', args: { extra: 1 } },
    { action: 'start_print', args: { file: 'a.gcode' } },
    { action: 'firmware_restart', args: {} },
    { action: 'pause', args: { extra: 1 } },
    { action: 'set_fan', args: { fan: 'part', percent: 101 } },
  ])
    bad({ kind: 'action', action, job: undefined })
})

test('size bounds: urls, names, digests, sizes, lifetime and the wire', () => {
  const job = (extra: Record<string, unknown>) =>
    claims({ job: { ...jobCommand.job, ...extra } })
  const accepts = (value: unknown) =>
    assert.ok(ApiEnvelopeV1.safeParse(value).success)
  const rejects = (value: unknown) =>
    assert.equal(ApiEnvelopeV1.safeParse(value).success, false)
  const prefix = 'https://f.example.invalid/'
  accepts(
    job({
      file_url:
        prefix + 'a'.repeat(MAX_API_ENVELOPE_FILE_URL_CHARS - prefix.length),
    }),
  )
  rejects(
    job({
      file_url:
        prefix +
        'a'.repeat(MAX_API_ENVELOPE_FILE_URL_CHARS - prefix.length + 1),
    }),
  )
  rejects(job({ file_url: 'http://files.example.invalid/a.gcode' }))
  rejects(job({ file_url: 'https://user:pw@files.example.invalid/a' }))
  rejects(job({ file_url: 'https://files.example.invalid/a b' }))
  rejects(job({ sha256: 'A'.repeat(64) }))
  rejects(job({ sha256: 'a'.repeat(63) }))
  rejects(job({ size_bytes: 0 }))
  rejects(job({ size_bytes: 1.5 }))
  accepts(job({ display_name: 'n'.repeat(255) }))
  rejects(job({ display_name: 'n'.repeat(256) }))
  rejects(job({ display_name: '' }))
  rejects(job({ display_name: 'bad\nname' }))
  accepts(claims({ expires_at: NOW + MIN_API_ENVELOPE_TTL_MS }))
  rejects(claims({ expires_at: NOW + MIN_API_ENVELOPE_TTL_MS - 1 }))
  accepts(claims({ expires_at: NOW + MAX_API_ENVELOPE_TTL_MS }))
  rejects(claims({ expires_at: NOW + MAX_API_ENVELOPE_TTL_MS + 1 }))
  rejects(claims({ expires_at: NOW - 1 }))
  // Even a schema-valid envelope must stay under the wire limit.
  assert.ok(MAX_API_ENVELOPE_WIRE_BYTES >= 3072)
})

test('a maximal envelope fits the wire limit and an oversize frame is refused', async () => {
  const { privateKey } = await issuerPair()
  const prefix = 'https://f.example.invalid/'
  const signed = await signApiEnvelope(
    claims({
      job: {
        ...jobCommand.job,
        file_url:
          prefix + 'a'.repeat(MAX_API_ENVELOPE_FILE_URL_CHARS - prefix.length),
        display_name: 'n'.repeat(255),
      },
    }),
    privateKey,
  )
  const wire = encodeApiEnvelopeFrame({
    v: 1,
    t: 'api-envelope.command',
    envelope: signed,
  })
  assert.ok(Buffer.byteLength(wire) <= MAX_API_ENVELOPE_WIRE_BYTES)
  assert.throws(() =>
    decodeApiEnvelopeFrame(wire + ' '.repeat(MAX_API_ENVELOPE_WIRE_BYTES)),
  )
  assert.throws(() => decodeApiEnvelopeFrame(42))
})

test('signing, verification and frames', async () => {
  const pair = await issuerPair()
  const other = await issuerPair()
  const signed = await signApiEnvelope(claims(), pair.privateKey)
  assert.ok(SignedApiEnvelopeV1.safeParse(signed).success)
  const pin = { farmId: FARM, agentId: AGENT, now: NOW + 1000 }
  const verdict = await verifyApiEnvelope(signed, pair.publicKey, pin)
  assert.equal(verdict.ok, true)
  // Wrong key, tampering, wrong pinned identity, expiry, future issue.
  assert.deepEqual(await verifyApiEnvelope(signed, other.publicKey, pin), {
    ok: false,
    reason: 'invalid',
  })
  assert.equal(
    (
      await verifyApiEnvelope(
        { ...signed, expires_at: signed.expires_at + 1 },
        pair.publicKey,
        pin,
      )
    ).ok,
    false,
  )
  assert.equal(
    (
      await verifyApiEnvelope(
        { ...signed, farm_id: OTHER_FARM },
        pair.publicKey,
        { ...pin, farmId: OTHER_FARM },
      )
    ).ok,
    false,
    'a changed field breaks the signature',
  )
  assert.deepEqual(
    await verifyApiEnvelope(signed, pair.publicKey, {
      ...pin,
      farmId: OTHER_FARM,
    }),
    { ok: false, reason: 'identity' },
  )
  assert.deepEqual(
    await verifyApiEnvelope(signed, pair.publicKey, {
      ...pin,
      agentId: OTHER_AGENT,
    }),
    { ok: false, reason: 'identity' },
  )
  assert.deepEqual(
    await verifyApiEnvelope(signed, pair.publicKey, {
      ...pin,
      now: signed.expires_at,
    }),
    { ok: false, reason: 'expired' },
  )
  assert.deepEqual(
    await verifyApiEnvelope(signed, pair.publicKey, {
      ...pin,
      now: NOW - API_ENVELOPE_CLOCK_SKEW_MS - 1,
    }),
    { ok: false, reason: 'not-yet-valid' },
  )
  assert.equal(
    (await verifyApiEnvelope(signed, pair.privateKey, pin)).ok,
    false,
    'only a public key verifies',
  )
  // Only a nonextractable Ed25519 private key signs.
  const extractable = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  await assert.rejects(signApiEnvelope(claims(), extractable.privateKey))
  await assert.rejects(signApiEnvelope(claims(), pair.publicKey))
  const p256 = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  await assert.rejects(signApiEnvelope(claims(), p256.privateKey))
  // Canonical frame round trip; reordered or padded wire is refused.
  const wire = encodeApiEnvelopeFrame({
    v: 1,
    t: 'api-envelope.command',
    envelope: signed,
  })
  assert.deepEqual(decodeApiEnvelopeFrame(wire).envelope, signed)
  assert.throws(() =>
    decodeApiEnvelopeFrame(JSON.stringify(JSON.parse(wire), null, 1)),
  )
  assert.throws(() =>
    decodeApiEnvelopeFrame(wire.replace('"v":1', '"v":1,"x":1')),
  )
})

test('the API issuer key is distributed through the signed trusted-key set', async () => {
  const setSigner = await issuerPair()
  const api = await issuerPair()
  const setIssuer = {
    issuer: 'open3dfarm:trusted-key-issuer',
    kid: 'set-1',
    public_key_spki: await spkiOf(setSigner.publicKey),
  }
  const apiIssuer = {
    issuer: API_ENVELOPE_ISSUER,
    kid: 'api-1',
    public_key_spki: await spkiOf(api.publicKey),
  }
  const keySet = await signTrustedKeySet(
    {
      v: 1,
      purpose: 'trusted-key-set',
      farm_id: FARM,
      version: 1,
      issued_at: NOW,
      issuer: setIssuer.issuer,
      kid: setIssuer.kid,
      issuer_keys: [apiIssuer, setIssuer].sort((a, b) =>
        a.kid < b.kid ? -1 : 1,
      ),
      browser_keys: [],
    },
    setSigner.privateKey,
  )
  assert.equal(await verifyTrustedKeySet(keySet, setSigner.publicKey), true)
  // The Connector picks the key by the envelope's issuer and kid from the verified set.
  const signed = await signApiEnvelope(claims(), api.privateKey)
  const listed = keySet.issuer_keys.find(
    (key) => key.issuer === signed.issuer && key.kid === signed.kid,
  )
  assert.ok(listed)
  const pinned = await crypto.subtle.importKey(
    'spki',
    Buffer.from(listed.public_key_spki, 'base64url'),
    'Ed25519',
    false,
    ['verify'],
  )
  assert.equal(
    (
      await verifyApiEnvelope(signed, pinned, {
        farmId: FARM,
        agentId: AGENT,
        now: NOW,
      })
    ).ok,
    true,
  )
  // The trusted-key-set signer's key never validates a command envelope.
  const wrong = await crypto.subtle.importKey(
    'spki',
    Buffer.from(setIssuer.public_key_spki, 'base64url'),
    'Ed25519',
    false,
    ['verify'],
  )
  assert.equal(
    (
      await verifyApiEnvelope(signed, wrong, {
        farmId: FARM,
        agentId: AGENT,
        now: NOW,
      })
    ).ok,
    false,
  )
})

test('result frames: refusal codes, details and history ids are bounded', () => {
  const base = {
    v: 1,
    t: 'api-envelope.result',
    cmd_id: randomUUID(),
    at: NOW,
  }
  const ok = (extra: Record<string, unknown>) => {
    const wire = encodeApiEnvelopeResultFrame({ ...base, ...extra })
    assert.deepEqual(decodeApiEnvelopeResultFrame(wire), {
      ...base,
      ...extra,
    })
  }
  const no = (extra: Record<string, unknown>) =>
    assert.throws(() => encodeApiEnvelopeResultFrame({ ...base, ...extra }))
  ok({ outcome: 'delivered' })
  ok({ outcome: 'started' })
  ok({ outcome: 'completed', history_entry_id: '42' })
  ok({ outcome: 'refused', refusal_code: 'printer-busy', detail: 'busy' })
  ok({ outcome: 'failed', detail: 'heater fault' })
  no({ outcome: 'refused' })
  no({ outcome: 'refused', refusal_code: 'made-up' })
  no({ outcome: 'completed', refusal_code: 'printer-busy' })
  no({ outcome: 'refused', refusal_code: 'expired', detail: 'x'.repeat(501) })
  no({ outcome: 'started', history_entry_id: '1' })
  no({ outcome: 'completed', history_entry_id: '1'.repeat(20) })
  no({ outcome: 'delivered', detail: 'nope' })
  no({ outcome: 'unknown' })
  no({ outcome: 'delivered', extra: 1 })
})

class MemoryDeliveryStore implements IntegrationDeliveryStore {
  rows = new Map<string, EnvelopeRecord>()
  authority = true
  private readonly outcomes: Record<string, readonly EnvelopeStatus[]> = {
    pending: ['sending', 'expired', 'rejected'],
    sending: [
      'pending',
      'sent',
      'outcome-unknown',
      'delivered',
      'refused',
      'started',
      'completed',
      'cancelled',
      'failed',
    ],
    sent: [
      'outcome-unknown',
      'delivered',
      'refused',
      'started',
      'completed',
      'cancelled',
      'failed',
    ],
    delivered: ['started', 'completed', 'cancelled', 'failed'],
    started: ['completed', 'cancelled', 'failed'],
  }
  async insert(envelope: NewEnvelope, now: number): Promise<InsertOutcome> {
    for (const row of this.rows.values())
      if (row.kind === envelope.kind && row.resourceId === envelope.resourceId)
        return { kind: 'existing', record: row }
    if (!this.authority) return { kind: 'refused' }
    const record: EnvelopeRecord = {
      ...envelope,
      status: 'pending',
      refusalCode: null,
      resultDetail: null,
      historyEntryId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.rows.set(record.cmdId, record)
    return { kind: 'created', record }
  }
  async get(cmdId: string) {
    return this.rows.get(cmdId) ?? null
  }
  async listPending(
    farmId: string,
    agentId: string,
    now: number,
    limit: number,
  ) {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.farmId === farmId &&
          row.agentId === agentId &&
          row.status === 'pending' &&
          row.expiresAt > now,
      )
      .slice(0, limit)
  }
  private set(row: EnvelopeRecord, patch: Partial<EnvelopeRecord>) {
    const next = { ...row, ...patch }
    this.rows.set(row.cmdId, next)
    return next
  }
  async claim(cmdId: string, now: number) {
    const row = this.rows.get(cmdId)
    if (
      !row ||
      row.status !== 'pending' ||
      row.expiresAt <= now ||
      !this.authority
    )
      return null
    return this.set(row, { status: 'sending', updatedAt: now })
  }
  async settleUnclaimable(cmdId: string, now: number) {
    const row = this.rows.get(cmdId)
    if (!row || row.status !== 'pending') return null
    if (row.expiresAt <= now)
      return this.set(row, { status: 'expired', updatedAt: now })
    if (!this.authority)
      return this.set(row, { status: 'rejected', updatedAt: now })
    return null
  }
  async transition(
    cmdId: string,
    from: readonly EnvelopeStatus[],
    to: EnvelopeStatus,
    now: number,
    result: EnvelopeResult = {},
  ) {
    const row = this.rows.get(cmdId)
    if (!row || !from.includes(row.status)) return null
    if (!this.outcomes[row.status]?.includes(to)) return null
    return this.set(row, {
      status: to,
      updatedAt: now,
      refusalCode: result.refusalCode ?? row.refusalCode,
      resultDetail: result.detail ?? row.resultDetail,
      historyEntryId: result.historyEntryId ?? row.historyEntryId,
    })
  }
  async sweep(now: number, limit: number) {
    const changed: EnvelopeRecord[] = []
    for (const row of this.rows.values()) {
      if (changed.length >= limit || row.expiresAt > now) continue
      if (row.status === 'pending')
        changed.push(this.set(row, { status: 'expired', updatedAt: now }))
      else if (row.status === 'sending' || row.status === 'sent')
        changed.push(
          this.set(row, { status: 'outcome-unknown', updatedAt: now }),
        )
    }
    return changed
  }
}
class MemoryAudit implements IntegrationAuditStore {
  rows: IntegrationAuditEntry[] = []
  failing = false
  async append(value: Omit<IntegrationAuditEntry, 'id'>) {
    if (this.failing) throw new Error('audit down')
    const saved = { ...value, id: String(this.rows.length + 1) }
    this.rows.push(saved)
    return saved
  }
  async listForOwner() {
    return this.rows
  }
}
class FakeInbox implements EnvelopeInbox {
  sent: { farmId: string; agentId: string; wire: string }[] = []
  mode: 'sent' | 'no-inbox' | 'throw' = 'sent'
  sendToAgentInbox(farmId: string, agentId: string, wire: string) {
    if (this.mode === 'throw') throw new Error('socket error')
    if (this.mode === 'no-inbox') return 'no-inbox' as const
    this.sent.push({ farmId, agentId, wire })
    return 'sent' as const
  }
}
async function fixture() {
  const pair = await issuerPair()
  const store = new MemoryDeliveryStore()
  const inbox = new FakeInbox()
  const auditStore = new MemoryAudit()
  const clock = { now: NOW }
  const errors: string[] = []
  const service = new IntegrationDeliveryService({
    store,
    inbox,
    audit: new IntegrationAuditService(auditStore, () => clock.now),
    signer: { kid: 'api-1', signingKey: pair.privateKey },
    now: () => clock.now,
    onError: (site) => errors.push(site),
  })
  const issue = async (
    command: typeof jobCommand | typeof pauseCommand = jobCommand,
    extra: Partial<Parameters<typeof service.issue>[0]> = {},
  ) => {
    const result = await service.issue({
      appId: APP,
      grantId: GRANT,
      farmId: FARM,
      agentId: AGENT,
      printerAssignmentId: ASSIGNMENT,
      resourceId: randomUUID(),
      ttlMs: 30_000,
      command,
      ...extra,
    })
    assert.ok(result.ok, 'issue')
    return result.record
  }
  const report = (cmdId: string, outcome: string, extra = {}) =>
    service.recordResult(
      FARM,
      AGENT,
      encodeApiEnvelopeResultFrame({
        v: 1,
        t: 'api-envelope.result',
        cmd_id: cmdId,
        outcome,
        at: clock.now,
        ...extra,
      }),
    )
  return {
    pair,
    store,
    inbox,
    auditStore,
    clock,
    errors,
    service,
    issue,
    report,
  }
}

test('a stored envelope verifies against the issuer key and carries its identity', async () => {
  const f = await fixture()
  const record = await f.issue()
  assert.equal(record.status, 'pending')
  assert.equal(record.requiredScope, 'jobs:start')
  const frame = decodeApiEnvelopeFrame(record.wire)
  assert.equal(frame.envelope.cmd_id, record.cmdId)
  assert.equal(frame.envelope.expires_at - frame.envelope.issued_at, 30_000)
  assert.equal(
    (
      await verifyApiEnvelope(frame.envelope, f.pair.publicKey, {
        farmId: FARM,
        agentId: AGENT,
        now: NOW,
      })
    ).ok,
    true,
  )
  assert.equal(requiredScopeFor(pauseCommand), 'control:basic')
  assert.equal(
    requiredScopeFor({
      kind: 'action',
      action: { action: 'home', args: { axes: ['x'] } },
    }),
    'control:extended',
  )
})

test('issue refuses bad lifetimes, unsupported actions, and a lost authority', async () => {
  const f = await fixture()
  for (const ttlMs of [
    0,
    MIN_API_ENVELOPE_TTL_MS - 1,
    MAX_API_ENVELOPE_TTL_MS + 1,
    1.5,
  ]) {
    assert.deepEqual(
      await f.service.issue({
        appId: APP,
        grantId: GRANT,
        farmId: FARM,
        agentId: AGENT,
        printerAssignmentId: ASSIGNMENT,
        resourceId: randomUUID(),
        ttlMs,
        command: jobCommand,
      }),
      { ok: false, reason: 'invalid' },
    )
  }
  assert.deepEqual(
    await f.service.issue({
      appId: APP,
      grantId: GRANT,
      farmId: FARM,
      agentId: AGENT,
      printerAssignmentId: ASSIGNMENT,
      resourceId: randomUUID(),
      ttlMs: 30_000,
      command: {
        kind: 'action',
        action: { action: 'start_print', args: { file: 'a.gcode' } },
      } as never,
    }),
    { ok: false, reason: 'invalid' },
  )
  f.store.authority = false
  assert.deepEqual(
    await f.service.issue({
      appId: APP,
      grantId: GRANT,
      farmId: FARM,
      agentId: AGENT,
      printerAssignmentId: ASSIGNMENT,
      resourceId: randomUUID(),
      ttlMs: 30_000,
      command: jobCommand,
    }),
    { ok: false, reason: 'refused' },
  )
  assert.equal(f.store.rows.size, 0)
})

test('one API resource never gets a second command', async () => {
  const f = await fixture()
  const resourceId = randomUUID()
  const first = await f.service.issue({
    appId: APP,
    grantId: GRANT,
    farmId: FARM,
    agentId: AGENT,
    printerAssignmentId: ASSIGNMENT,
    resourceId,
    ttlMs: 30_000,
    command: jobCommand,
  })
  const second = await f.service.issue({
    appId: APP,
    grantId: GRANT,
    farmId: FARM,
    agentId: AGENT,
    printerAssignmentId: ASSIGNMENT,
    resourceId,
    ttlMs: 30_000,
    command: jobCommand,
  })
  assert.ok(first.ok && second.ok)
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.record.cmdId, first.record.cmdId)
  assert.equal(f.store.rows.size, 1)
})

test('delivery writes to the inbox at most once, ever', async () => {
  const f = await fixture()
  const record = await f.issue()
  assert.equal(await f.service.deliver(record.cmdId), 'sent')
  assert.equal(f.inbox.sent.length, 1)
  assert.equal(f.inbox.sent[0]!.wire, record.wire)
  assert.deepEqual(
    [f.inbox.sent[0]!.farmId, f.inbox.sent[0]!.agentId],
    [FARM, AGENT],
  )
  // Repeated delivery, an inbox reconnect and a sweep before expiry never resend.
  assert.equal(await f.service.deliver(record.cmdId), 'sent')
  assert.deepEqual(await f.service.deliverPending(FARM, AGENT), [])
  assert.equal(await f.service.sweep(), 0)
  assert.equal(f.inbox.sent.length, 1)
  assert.equal(f.store.rows.get(record.cmdId)!.status, 'sent')
  // Concurrent callers race for one claim.
  const racing = await f.issue(pauseCommand)
  const results = await Promise.all([
    f.service.deliver(racing.cmdId),
    f.service.deliver(racing.cmdId),
    f.service.deliver(racing.cmdId),
  ])
  assert.equal(f.inbox.sent.filter((s) => s.wire === racing.wire).length, 1)
  assert.ok(results.includes('sent'))
})

test('without a live inbox nothing is sent and the envelope waits until it expires', async () => {
  const f = await fixture()
  f.inbox.mode = 'no-inbox'
  const first = await f.issue()
  const second = await f.issue(pauseCommand)
  assert.deepEqual(await f.service.deliverPending(FARM, AGENT), ['no-inbox'])
  assert.equal(f.store.rows.get(first.cmdId)!.status, 'pending')
  assert.equal(f.inbox.sent.length, 0)
  // The inbox proves its credential: waiting envelopes leave in order.
  f.inbox.mode = 'sent'
  assert.deepEqual(await f.service.deliverPending(FARM, AGENT), [
    'sent',
    'sent',
  ])
  assert.deepEqual(
    f.inbox.sent.map((s) => s.wire),
    [first.wire, second.wire],
  )
})

test('an uncertain write ends as outcome-unknown and is never resent', async () => {
  const f = await fixture()
  f.inbox.mode = 'throw'
  const record = await f.issue()
  assert.equal(await f.service.deliver(record.cmdId), 'uncertain')
  assert.equal(f.store.rows.get(record.cmdId)!.status, 'outcome-unknown')
  assert.deepEqual(f.errors, ['inbox'])
  f.inbox.mode = 'sent'
  assert.equal(await f.service.deliver(record.cmdId), 'outcome-unknown')
  assert.deepEqual(await f.service.deliverPending(FARM, AGENT), [])
  assert.equal(f.inbox.sent.length, 0)
  // A late result cannot change a final status.
  assert.equal(await f.report(record.cmdId, 'completed'), 'ignored')
  assert.equal(f.store.rows.get(record.cmdId)!.status, 'outcome-unknown')
  const entry = f.auditStore.rows.at(-1)!
  assert.equal(entry.outcome, 'unknown')
  assert.equal(entry.actorKind, 'system')
})

test('undelivered envelopes expire; unconfirmed deliveries become unknown', async () => {
  const f = await fixture()
  const unclaimed = await f.issue()
  const sent = await f.issue()
  assert.equal(await f.service.deliver(sent.cmdId), 'sent')
  const crashed = await f.issue()
  // A claim whose process died before it wrote or recorded anything.
  await f.store.claim(crashed.cmdId, NOW)
  f.inbox.mode = 'no-inbox'
  f.clock.now = NOW + 30_000
  // Expired envelopes are never claimed or written, even when asked directly.
  const before = f.inbox.sent.length
  f.inbox.mode = 'sent'
  assert.equal(await f.service.deliver(unclaimed.cmdId), 'expired')
  assert.equal(f.inbox.sent.length, before)
  assert.equal(await f.service.sweep(), 2)
  assert.equal(f.store.rows.get(sent.cmdId)!.status, 'outcome-unknown')
  assert.equal(f.store.rows.get(crashed.cmdId)!.status, 'outcome-unknown')
  assert.equal(f.store.rows.get(unclaimed.cmdId)!.status, 'expired')
  assert.equal(await f.service.sweep(), 0)
  assert.equal(f.inbox.sent.length, before)
  // Once expired, a Connector result cannot revive it.
  assert.equal(await f.report(unclaimed.cmdId, 'started'), 'ignored')
  assert.equal(f.store.rows.get(unclaimed.cmdId)!.status, 'expired')
})

test('a pending sweep expires envelopes nobody tried to deliver', async () => {
  const f = await fixture()
  const waiting = await f.issue()
  f.clock.now = waiting.expiresAt
  assert.equal(await f.service.sweep(), 1)
  assert.equal(f.store.rows.get(waiting.cmdId)!.status, 'expired')
  assert.deepEqual(await f.service.deliverPending(FARM, AGENT), [])
  assert.equal(f.inbox.sent.length, 0)
})

test('a revoked grant, app or assignment rejects the envelope before it is sent', async () => {
  const f = await fixture()
  const record = await f.issue()
  f.store.authority = false
  assert.equal(await f.service.deliver(record.cmdId), 'rejected')
  assert.equal(f.inbox.sent.length, 0)
  assert.equal(f.store.rows.get(record.cmdId)!.status, 'rejected')
  assert.equal(f.auditStore.rows.at(-1)!.outcome, 'rejected')
})

test('connector results are stored, scoped to their agent and never regress', async () => {
  const f = await fixture()
  const job = await f.issue()
  await f.service.deliver(job.cmdId)
  // Reports from another farm or agent never touch the envelope.
  const frame = (outcome: string, extra = {}) =>
    encodeApiEnvelopeResultFrame({
      v: 1,
      t: 'api-envelope.result',
      cmd_id: job.cmdId,
      outcome,
      at: NOW,
      ...extra,
    })
  assert.equal(
    await f.service.recordResult(FARM, OTHER_AGENT, frame('delivered')),
    'unknown-command',
  )
  assert.equal(
    await f.service.recordResult(OTHER_FARM, AGENT, frame('delivered')),
    'unknown-command',
  )
  assert.equal(await f.service.recordResult(FARM, AGENT, 'not json'), 'ignored')
  assert.equal(
    await f.service.recordResult(
      FARM,
      AGENT,
      frame('delivered').replace(job.cmdId, randomUUID()),
    ),
    'unknown-command',
  )
  assert.equal(f.store.rows.get(job.cmdId)!.status, 'sent')
  assert.equal(await f.report(job.cmdId, 'delivered'), 'recorded')
  assert.equal(await f.report(job.cmdId, 'delivered'), 'duplicate')
  assert.equal(
    await f.report(job.cmdId, 'refused', { refusal_code: 'expired' }),
    'ignored',
  )
  assert.equal(await f.report(job.cmdId, 'started'), 'recorded')
  assert.equal(
    await f.report(job.cmdId, 'delivered'),
    'ignored',
    'no regression',
  )
  assert.equal(
    await f.report(job.cmdId, 'completed', { history_entry_id: '77' }),
    'recorded',
  )
  assert.equal(
    await f.report(job.cmdId, 'failed'),
    'ignored',
    'final never changes',
  )
  const stored = f.store.rows.get(job.cmdId)!
  assert.equal(stored.status, 'completed')
  assert.equal(stored.historyEntryId, '77')
  assert.deepEqual(
    f.auditStore.rows.map((row) => [
      row.actorKind,
      row.outcome,
      row.details.status,
    ]),
    [
      ['system', 'accepted', 'sent'],
      ['connector', 'accepted', 'delivered'],
      ['connector', 'accepted', 'started'],
      ['connector', 'succeeded', 'completed'],
    ],
  )
})

test('refusals keep their code and detail; actions cannot report job-only outcomes', async () => {
  const f = await fixture()
  const job = await f.issue()
  await f.service.deliver(job.cmdId)
  assert.equal(
    await f.report(job.cmdId, 'refused', {
      refusal_code: 'checksum-mismatch',
      detail: 'digest differs',
    }),
    'recorded',
  )
  const refused = f.store.rows.get(job.cmdId)!
  assert.equal(refused.status, 'refused')
  assert.equal(refused.refusalCode, 'checksum-mismatch')
  assert.equal(refused.resultDetail, 'digest differs')
  const action = await f.issue(pauseCommand)
  await f.service.deliver(action.cmdId)
  assert.equal(await f.report(action.cmdId, 'started'), 'ignored')
  assert.equal(await f.report(action.cmdId, 'cancelled'), 'ignored')
  assert.equal(await f.report(action.cmdId, 'completed'), 'recorded')
  assert.equal(f.store.rows.get(action.cmdId)!.status, 'completed')
  const last = f.auditStore.rows.at(-1)!
  assert.equal(last.resourceType, 'action')
  assert.equal(last.actorId, AGENT)
  assert.equal(last.details.jobStatus, undefined)
})

test('an audit failure never undoes or repeats a delivery', async () => {
  const f = await fixture()
  f.auditStore.failing = true
  const record = await f.issue()
  assert.equal(await f.service.deliver(record.cmdId), 'sent')
  assert.equal(f.store.rows.get(record.cmdId)!.status, 'sent')
  assert.equal(f.inbox.sent.length, 1)
  assert.ok(f.errors.includes('audit'))
  assert.equal(await f.service.deliver(record.cmdId), 'sent')
  assert.equal(f.inbox.sent.length, 1)
})
