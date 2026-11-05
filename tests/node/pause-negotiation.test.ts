import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { PostgresPauseNegotiation } from '../../apps/farm/server/storage/postgres-pause-negotiation.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { connectorKeyBinding } from '../../apps/farm/server/utils/connector-credentials.ts'

async function fixture() {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    keys.publicKey,
  )
  const browser = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const publicKeySpki = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64url')
  const connector = await connectorKeyBinding(publicKeySpki)
  const scope = {
    sessionRecordId: 'sealed-session-ref',
    farmId: randomUUID(),
    agentId: randomUUID(),
    keyId: randomUUID(),
    assignmentId: randomUUID(),
  }
  const now = Date.now()
  const config = {
    origin: 'https://farm.example.test',
    audience: 'pause-control',
    credentialIssuer: 'credential-issuer',
    credentialAudience: 'credential-audience',
    idleTimeoutMs: 1800000,
  }
  const rows: Record<string, Record<string, unknown>[]> = {
    account: [{ id: 'actual-account', sessionVersion: 2, disabled: false }],
    session: [
      {
        id: scope.sessionRecordId,
        accountId: 'actual-account',
        accountVersion: 2,
        createdAt: now - 60000,
        lastSeenAt: now - 10000,
        absoluteExpiresAt: now + 60000,
        revokedAt: null,
      },
    ],
    member: [{ role: 'operator', revoked_at: null }],
    key: [
      {
        status: 'approved',
        public_key: browser.publicKey,
        thumbprint: browser.thumbprint,
        approved_at: now - 1000,
        revoked_at: null,
      },
    ],
    enrollment: [
      {
        farm_id: scope.farmId,
        status: 'approved',
        public_key_spki: publicKeySpki,
        fingerprint: connector.fingerprint,
      },
    ],
    credential: [
      {
        jti: randomUUID(),
        farm_id: scope.farmId,
        fingerprint: connector.fingerprint,
        thumbprint: connector.thumbprint,
        issuer: config.credentialIssuer,
        audience: config.credentialAudience,
        issued_at: Math.floor(now / 1000) - 10,
        expires_at: Math.floor(now / 1000) + 120,
      },
    ],
    slot: [],
    revoked: [],
    assignment: [
      {
        farm_id: scope.farmId,
        agent_id: scope.agentId,
        printer_key: 'opaque / printer #1',
        revoked_at: null,
      },
    ],
  }
  const calls: { text: string; values: readonly unknown[] }[] = []
  let begins = 0,
    commits = 0,
    observations = 0
  let onCommit: (() => void) | undefined
  let observation: (count: number) => number | null = () => Date.now()
  const tag = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?')
    calls.push({ text, values })
    if (text.startsWith('SET LOCAL')) return []
    if (text.includes('observe_signalling_session_expiry'))
      return [{ now: observation(++observations) }]
    const target = text.includes('FROM farm.session_accounts')
      ? 'account'
      : text.includes('FROM farm.account_sessions')
        ? 'session'
        : text.includes('FROM farm.memberships')
          ? 'member'
          : text.includes('FROM farm.browser_device_keys')
            ? 'key'
            : text.includes('FROM farm.connector_enrollments')
              ? 'enrollment'
              : text.includes('FROM farm.connector_credentials')
                ? 'credential'
                : text.includes('FROM farm.connector_credential_proofs')
                  ? 'slot'
                  : text.includes('FROM farm.connector_revocations')
                    ? 'revoked'
                    : text.includes('FROM farm.printer_assignments')
                      ? 'assignment'
                      : undefined
    if (!target) throw new Error('Unexpected SQL in contract fixture')
    return structuredClone(rows[target])
  }
  // Deliberate SQL boundary double, not a PostgreSQL privilege or race acceptance test.
  const sql = Object.assign(tag, {
    async begin(run: (tx: typeof tag) => Promise<unknown>) {
      begins++
      const result = await run(tag)
      onCommit?.()
      commits++
      return result
    },
  }) as unknown as Sql
  return {
    scope,
    config,
    rows,
    calls,
    now,
    sql,
    counts: () => ({ begins, commits, observations }),
    setObservation(fn: typeof observation) {
      observation = fn
    },
    setCommit(fn: () => void) {
      onCommit = fn
    },
  }
}

test('pause negotiation derives exact current DB scope, native key bindings and private printer metadata', async () => {
  const f = await fixture()
  const result = await new PostgresPauseNegotiation(f.sql, f.config).read(
    f.scope,
  )
  assert.ok(result)
  assert.equal(result.authority.account_id, 'actual-account')
  assert.equal(result.authority.assignment_id, f.scope.assignmentId)
  assert.equal(result.authority.role, 'operator')
  assert.equal(result.authority.audience, 'pause-control')
  assert.equal(result.printerKey, 'opaque / printer #1')
  assert.equal('printerKey' in result.authority, false)
  assert.equal('capability' in result, false)
  assert.equal('commands_enabled' in result.authority, false)
  assert.ok(result.budget.monotonicDeadline > performance.now())
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(result.authority) &&
      Object.isFrozen(result.authority.browser_public_key),
  )
  assert.deepEqual(f.counts(), { begins: 1, commits: 1, observations: 2 })
  const locks = f.calls.filter((call) => /FOR (SHARE|UPDATE)/.test(call.text))
  assert.deepEqual(
    locks.map((call) => /FROM farm\.(\w+)/.exec(call.text)?.[1]),
    [
      'memberships',
      'browser_device_keys',
      'connector_enrollments',
      'connector_credentials',
      'connector_credential_proofs',
      'printer_assignments',
    ],
  )
  assert.match(locks[3]!.text, /FOR UPDATE$/)
  assert.deepEqual(locks[1]!.values, [
    f.scope.keyId,
    f.scope.farmId,
    'actual-account',
  ])
  assert.deepEqual(locks[5]!.values, [f.scope.assignmentId])
  assert.equal(
    f.calls.some((call) => /^(UPDATE|INSERT|DELETE)/.test(call.text)),
    false,
  )
})

test('invalid or caller-enriched scope is rejected before any database work', async () => {
  const f = await fixture()
  const reader = new PostgresPauseNegotiation(f.sql, f.config)
  for (const input of [
    null,
    { ...f.scope, assignmentId: 'bad' },
    { ...f.scope, accountId: 'attacker' },
    { ...f.scope, publicKey: {} },
    { ...f.scope, now: 1 },
    { ...f.scope, url: 'http://printer' },
  ])
    assert.equal(await reader.read(input), null)
  assert.equal(f.counts().begins, 0)
  assert.throws(
    () =>
      new PostgresPauseNegotiation(f.sql, { ...f.config, idleTimeoutMs: 1 }),
  )
})

test('viewer, inactive records, mismatched ownership and key material fail closed', async () => {
  const changes: [string, Record<string, unknown>][] = [
    ['member', { role: 'viewer' }],
    ['member', { revoked_at: 1 }],
    ['key', { status: 'pending' }],
    ['key', { approved_at: null }],
    ['key', { revoked_at: 1 }],
    ['key', { thumbprint: 'A'.repeat(43) }],
    ['enrollment', { status: 'revoked' }],
    ['enrollment', { farm_id: randomUUID() }],
    ['enrollment', { fingerprint: 'SHA256:' + 'A'.repeat(43) }],
    ['credential', { audience: 'pause-control' }],
    ['credential', { issuer: 'foreign' }],
    ['credential', { thumbprint: 'A'.repeat(43) }],
    ['credential', { farm_id: randomUUID() }],
    ['assignment', { revoked_at: 1 }],
    ['assignment', { farm_id: randomUUID() }],
    ['assignment', { agent_id: randomUUID() }],
    ['assignment', { printer_key: '\0' }],
    ['account', { disabled: true }],
    ['account', { sessionVersion: 3 }],
    ['session', { accountId: 'foreign' }],
    ['session', { revokedAt: 1 }],
  ]
  for (const [table, patch] of changes) {
    const f = await fixture()
    Object.assign(f.rows[table]![0]!, patch)
    assert.equal(
      await new PostgresPauseNegotiation(f.sql, f.config).read(f.scope),
      null,
      table + JSON.stringify(patch),
    )
    assert.equal(f.counts().commits, 1)
    assert.equal(f.counts().observations, 2)
  }
})

test('absent proof slot is allowed, terminal or future watermark and revocation deny', async () => {
  for (const mode of ['absent', 'active', 'terminal', 'future', 'revoked']) {
    const f = await fixture()
    if (mode !== 'absent')
      f.rows.slot = [
        {
          observed_at: mode === 'future' ? f.now + 60000 : f.now - 100,
          credential_expired_at: mode === 'terminal' ? f.now - 1 : null,
        },
      ]
    if (mode === 'revoked') f.rows.revoked = [{ agent_id: f.scope.agentId }]
    const result = await new PostgresPauseNegotiation(f.sql, f.config).read(
      f.scope,
    )
    assert.equal(result !== null, mode === 'absent' || mode === 'active', mode)
    assert.equal(f.counts().commits, 1)
  }
})

test('final observation commits expiry denial after waits and rejects rollback/future issuance', async () => {
  for (const mode of ['null', 'regression', 'expired', 'future-credential']) {
    const f = await fixture()
    f.setObservation((count) =>
      count === 1
        ? f.now
        : mode === 'null'
          ? null
          : mode === 'regression'
            ? f.now - 1
            : mode === 'expired'
              ? f.now + 60000
              : f.now,
    )
    if (mode === 'future-credential') {
      f.rows.credential![0]!.issued_at = Math.floor(f.now / 1000) + 30
    }
    assert.equal(
      await new PostgresPauseNegotiation(f.sql, f.config).read(f.scope),
      null,
      mode,
    )
    assert.deepEqual(f.counts(), { begins: 1, commits: 1, observations: 2 })
  }
  const f = await fixture()
  f.setObservation(() => null)
  assert.equal(
    await new PostgresPauseNegotiation(f.sql, f.config).read(f.scope),
    null,
  )
  assert.deepEqual(f.counts(), { begins: 1, commits: 1, observations: 1 })
})

test('scope and config are captured before awaits; commit failure yields no snapshot', async () => {
  const f = await fixture()
  const expected = f.scope.assignmentId
  const reader = new PostgresPauseNegotiation(f.sql, f.config)
  f.config.audience = 'mutated-after-construction'
  const pending = reader.read(f.scope)
  f.scope.assignmentId = randomUUID()
  const result = await pending
  assert.ok(result)
  assert.equal(result.authority.assignment_id, expected)
  assert.equal(result.authority.audience, 'pause-control')
  const g = await fixture()
  g.setCommit(() => {
    throw new Error('commit failed')
  })
  assert.equal(
    await new PostgresPauseNegotiation(g.sql, g.config).read(g.scope),
    null,
  )
})

test('post-COMMIT monotonic budget subtracts the full round trip and denies consumed expiry', async (t) => {
  const f = await fixture()
  let wall = f.now,
    mono = 1000
  t.mock.method(Date, 'now', () => wall)
  t.mock.method(performance, 'now', () => mono)
  f.setObservation(() => wall)
  f.setCommit(() => {
    wall += 3000
    mono += 3000
  })
  const result = await new PostgresPauseNegotiation(f.sql, f.config).read(
    f.scope,
  )
  assert.ok(result)
  assert.equal(
    result.budget.monotonicDeadline,
    1000 + result.authority.validUntil - f.now,
  )
  f.setCommit(() => {
    wall += 60000
    mono += 60000
  })
  assert.equal(
    await new PostgresPauseNegotiation(f.sql, f.config).read(f.scope),
    null,
  )
})
