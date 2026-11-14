import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registrationAdmission } from '../helpers/kobralink-rtc/admission.ts'

const checkout = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const env = {
  KOBRALINK_RTC_ADMITTED: 'yes',
  KOBRALINK_RTC_CONTEXT: 'colima-openfarm-kobralink-togiej',
  KOBRALINK_RTC_EVIDENCE: checkout + '/.output/kobralink-rtc-evidence',
  KOBRALINK_RTC_POSTGRES_IMAGE: 'postgres:17@sha256:' + 'a'.repeat(64),
  KOBRALINK_RTC_KOBRA_IMAGE: 'kobralink@sha256:' + 'b'.repeat(64),
  KOBRALINK_RTC_UPSTREAM_REVISION: '5a5e5d9',
  KOBRALINK_RTC_DB_PORT: '15432',
  KOBRALINK_RTC_HTTPS_PORT: '18443',
  KOBRALINK_RTC_KOBRA_PORT: '17100',
  KOBRALINK_RTC_MQTT_PORT: '18883',
}

test('accepts an explicit isolated registration admission', () => {
  assert.deepEqual(
    registrationAdmission(env, checkout).ports,
    [15432, 18443, 17100, 18883],
  )
})

for (const [key, value] of Object.entries({
  KOBRALINK_RTC_ADMITTED: '',
  KOBRALINK_RTC_CONTEXT: 'orbstack',
  KOBRALINK_RTC_EVIDENCE: '/checkout/evidence',
  KOBRALINK_RTC_POSTGRES_IMAGE: 'postgres:17',
  KOBRALINK_RTC_KOBRA_IMAGE: 'kobralink:latest',
  KOBRALINK_RTC_UPSTREAM_REVISION: 'main',
  KOBRALINK_RTC_DB_PORT: '5432.5',
  KOBRALINK_RTC_HTTPS_PORT: '15432',
  KOBRALINK_RTC_KOBRA_PORT: '80',
  KOBRALINK_RTC_MQTT_PORT: '65536',
})) {
  test(`rejects unsafe ${key} before resource creation`, () => {
    assert.throws(() =>
      registrationAdmission({ ...env, [key]: value }, checkout),
    )
  })
}

test('rejects evidence in a sibling whose name merely starts with dots', () => {
  assert.throws(() =>
    registrationAdmission(
      { ...env, KOBRALINK_RTC_EVIDENCE: '/checkout/..evidence' },
      '/checkout',
    ),
  )
})

import {
  ADDITIONAL,
  QUALIFICATIONS,
  REQUIRED_CHECKS,
  WORLDS,
  aggregate,
  classifyBody,
  expectsBody,
  findSecrets,
  leasePhase,
  normalizePath,
  selectWorlds,
  sensitiveLeaves,
  unexplainedConsoleIssues,
  verifyReport,
  type CheckRecord,
} from '../helpers/kobralink-rtc/qualification.ts'

const everyCheck = (): CheckRecord[] =>
  [...QUALIFICATIONS, ...ADDITIONAL].flatMap((qualification) =>
    REQUIRED_CHECKS[qualification].map((id) => ({
      world: 'positive' as const,
      qualification,
      id,
      ok: true,
    })),
  )

test('the gate names exactly the twelve required qualifications', () => {
  assert.equal(QUALIFICATIONS.length, 12)
  assert.equal(new Set(QUALIFICATIONS).size, 12)
  for (const name of [...QUALIFICATIONS, ...ADDITIONAL])
    assert.ok(REQUIRED_CHECKS[name].length > 0)
})

test('passes only when every required check was recorded and none failed', () => {
  const summary = aggregate(everyCheck())
  assert.equal(summary.status, 'pass')
  assert.deepEqual(summary.missing, [])
  for (const name of QUALIFICATIONS) assert.equal(summary.results[name], 'pass')
})

test('a check that never ran is not-executed, never a pass', () => {
  const records = everyCheck().filter(
    (record) => record.id !== 'old-ack-on-new-transport-refused',
  )
  const summary = aggregate(records)
  assert.equal(summary.status, 'fail')
  assert.equal(summary.results.late_ack_fresh_authority, 'not-executed')
  assert.deepEqual(summary.missing, [
    {
      qualification: 'late_ack_fresh_authority',
      id: 'old-ack-on-new-transport-refused',
    },
  ])
  assert.equal(aggregate([]).status, 'fail')
})

test('one failed check fails its qualification even when repeated as passed', () => {
  const failed: CheckRecord = {
    world: 'authority',
    qualification: 'revoked_authority_refused',
    id: 'viewer-refused',
    ok: false,
  }
  const summary = aggregate([...everyCheck(), failed])
  assert.equal(summary.status, 'fail')
  assert.equal(summary.results.revoked_authority_refused, 'fail')
  assert.equal(summary.results.single_ui, 'pass')
  assert.deepEqual(summary.failures, [failed])
})

test('the think-time addition keeps the overall status from passing', () => {
  const records = everyCheck().map((record) =>
    record.id === 'prepare-near-rotation-recoverable'
      ? { ...record, ok: false }
      : record,
  )
  const summary = aggregate(records)
  assert.equal(summary.results.think_time_lease_renewal, 'fail')
  assert.equal(summary.status, 'fail')
  for (const name of QUALIFICATIONS) assert.equal(summary.results[name], 'pass')
})

test('selects every world by default and refuses unknown or repeated names', () => {
  assert.deepEqual(selectWorlds(undefined), WORLDS)
  assert.deepEqual(selectWorlds(''), WORLDS)
  assert.deepEqual(selectWorlds('late-ack,positive'), ['positive', 'late-ack'])
  assert.throws(() => selectWorlds('positive,positive'))
  assert.throws(() => selectWorlds('production'))
})

test('classifies a submission against the production minimum context', () => {
  const lease = { issuedAt: 1000, expiresAt: 10000 }
  assert.equal(leasePhase(null, 2000, 5000), 'offline')
  assert.equal(leasePhase(lease, 999, 5000), 'offline')
  assert.equal(leasePhase(lease, 10000, 5000), 'offline')
  assert.equal(leasePhase(lease, 5000, 5000), 'admissible')
  assert.equal(leasePhase(lease, 5001, 5000), 'near-rotation')
})

test('finds credential-like values by label without returning them', () => {
  const secrets = sensitiveLeaves(
    {
      farm_id: 'not-a-credential-identifier',
      bridge: { password: 'machine-account-password', origin: 'http://x' },
      binding: { credential_jti: '0f0f0f0f-public-binding-identifier' },
      sessions: [{ cookie: 'better-auth-session-value' }],
      short: { token: 'tiny' },
    },
    'state/bridge.json',
  )
  assert.deepEqual(
    secrets.map((secret) => secret.label),
    ['state/bridge.json:bridge.password', 'state/bridge.json:sessions.cookie'],
  )
  assert.deepEqual(findSecrets('<p>better-auth-session-value</p>', secrets), [
    'state/bridge.json:sessions.cookie',
  ])
  assert.deepEqual(
    findSecrets('<p>not-a-credential-identifier</p>', secrets),
    [],
  )
})

test('normalizes opaque identifiers out of published paths', () => {
  assert.equal(
    normalizePath(
      '/api/farms/8f8d7c1a-0194-41f9-9078-0dc507e595eb/connectors/f4021600-4a0a-40e6-b167-8a10932b8345/configuration',
    ),
    '/api/farms/:id/connectors/:id/configuration',
  )
})

test('only a read, bodyless or browser-aborted response body is accounted for', () => {
  const ok = { method: 'GET', status: 200, bodyRead: false, failure: null }
  assert.equal(classifyBody({ ...ok, bodyRead: true }), 'read')
  // Read wins even when the browser later reported the request as failed.
  assert.equal(
    classifyBody({ ...ok, bodyRead: true, failure: 'net::ERR_ABORTED' }),
    'read',
  )
  for (const [method, status] of [
    ['HEAD', 200],
    ['GET', 204],
    ['GET', 205],
    ['GET', 304],
    ['GET', 101],
  ] as const) {
    assert.equal(expectsBody(method, status), false)
    assert.equal(classifyBody({ ...ok, method, status }), 'bodyless')
  }
  // A superseded load: the 503 of run 86da29db was aborted mid-body.
  assert.equal(
    classifyBody({ ...ok, status: 503, failure: 'net::ERR_ABORTED' }),
    'aborted',
  )
  // An unread redirect is never excused, even when the browser aborted it.
  for (const status of [301, 302, 303, 307, 308])
    assert.equal(
      classifyBody({ ...ok, status, failure: 'net::ERR_ABORTED' }),
      'unread',
    )
  // Anything else body-bearing that was not read is never treated as clean.
  for (const failure of [null, 'net::ERR_CONNECTION_RESET', 'unknown', ''])
    for (const status of [200, 201, 302, 307, 400, 404, 500, 503])
      assert.equal(classifyBody({ ...ok, status, failure }), 'unread')
})

test('a closed-before-established warning needs its own page close while connecting', () => {
  const text = (path: string) =>
    `WebSocket connection to 'wss://127.0.0.1:58106${path}' failed: WebSocket is closed before the connection is established.`
  const warning = {
    page: 'owner',
    type: 'warning',
    text: text('/api/signalling/browser'),
  }
  const close = { page: 'owner', path: '/api/signalling/browser' }
  // Run de3c89dd: one superseded feed closed its CONNECTING socket.
  assert.deepEqual(unexplainedConsoleIssues([warning], [close]), [])
  // Without a recorded page close the warning stays unexplained.
  assert.deepEqual(unexplainedConsoleIssues([warning], []), [warning])
  // One close explains exactly one warning, never a surplus.
  assert.deepEqual(unexplainedConsoleIssues([warning, warning], [close]), [
    warning,
  ])
  // Page, path and type must all match the recorded close.
  for (const other of [
    { ...warning, page: 'viewer' },
    { ...warning, type: 'error' },
    { ...warning, text: text('/api/signalling/connector') },
    { ...warning, text: text('/api/signalling/config-browser') },
  ])
    assert.deepEqual(unexplainedConsoleIssues([other], [close]), [other])
  // A genuine connection failure is never excused by a close.
  for (const failure of [
    `WebSocket connection to 'wss://127.0.0.1:58106/api/signalling/browser' failed: Error during WebSocket handshake: Unexpected response code: 401`,
    `WebSocket connection to 'wss://127.0.0.1:58106/api/signalling/browser' failed: `,
    `${text('/api/signalling/browser')} extra`,
  ]) {
    const issue = { ...warning, text: failure }
    assert.deepEqual(unexplainedConsoleIssues([issue], [close]), [issue])
  }
})

const passing = () => ({
  status: 'pass',
  complete: true,
  qualifications: Object.fromEntries(QUALIFICATIONS.map((q) => [q, 'pass'])),
  additional: Object.fromEntries(ADDITIONAL.map((q) => [q, 'pass'])),
})

test('verify-report accepts only twelve passes plus the think-time addition', () => {
  assert.deepEqual(verifyReport(passing()), [])
  assert.ok(verifyReport(null).length)
  assert.ok(verifyReport({ ...passing(), status: 'fail' }).length)
  assert.ok(verifyReport({ ...passing(), complete: false }).length)
  for (const name of QUALIFICATIONS) {
    const missing = passing()
    delete missing.qualifications[name]
    assert.deepEqual(verifyReport(missing), [`${name} is absent`])
    const report = passing()
    report.qualifications[name] = 'not-executed'
    assert.deepEqual(verifyReport(report), [`${name} is not-executed`])
  }
})

test('verify-report refuses a think-time refusal that is not recoverable', () => {
  const report = passing()
  report.additional.think_time_lease_renewal = 'fail'
  assert.deepEqual(verifyReport(report), ['think_time_lease_renewal is fail'])
  assert.deepEqual(verifyReport({ ...passing(), additional: undefined }), [
    'think_time_lease_renewal is absent',
  ])
})

test('the committed report is read strictly, whatever it currently says', async () => {
  const { readFile } = await import('node:fs/promises')
  const report: unknown = JSON.parse(
    await readFile(
      new URL(
        '../../docs/compatibility/kobralink-rtc-acceptance.json',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  const problems = verifyReport(report)
  const status = (report as { status?: unknown }).status
  assert.equal(problems.length === 0, status === 'pass')
})

test('evidence admission rejects external, unignored, tracked and symlink paths', async () => {
  const { admitEvidence, admitEvidenceChild } =
    await import('../helpers/kobralink-rtc/admission.ts')
  const { mkdir, mkdtemp, writeFile, symlink, rm } =
    await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const base = checkout + '/.output/kobralink-rtc-evidence'
  await mkdir(base, { recursive: true, mode: 0o700 })
  const fixture = await mkdtemp(base + '/admission-')
  const evidence = fixture + '/.output/kobralink-rtc-evidence'
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: fixture, stdio: 'pipe' })
  try {
    git('init', '-q')
    await mkdir(evidence, { recursive: true })
    assert.throws(() => admitEvidence(evidence, fixture))
    await writeFile(fixture + '/.gitignore', '.output/\n')
    assert.doesNotThrow(() => admitEvidence(evidence, fixture))
    for (const path of [
      fixture + '/evidence',
      base,
      evidence + '-other',
      evidence + '/child',
    ])
      assert.throws(() => admitEvidence(path, fixture))
    await writeFile(evidence + '/tracked.txt', 'synthetic')
    git('add', '-f', '.output/kobralink-rtc-evidence/tracked.txt')
    assert.throws(() => admitEvidence(evidence, fixture))
    git('rm', '--cached', '-f', '.output/kobralink-rtc-evidence/tracked.txt')
    await rm(evidence, { recursive: true })
    await symlink(base, evidence)
    assert.throws(() => admitEvidence(evidence, fixture))

    // Nested child admission coverage
    await rm(evidence, { force: true })
    await mkdir(evidence, { recursive: true })
    const runDir = evidence + '/run-123'
    await mkdir(runDir)
    assert.doesNotThrow(() => admitEvidenceChild(runDir, fixture))
    assert.doesNotThrow(() => admitEvidenceChild(runDir + '/layer', fixture))
    assert.throws(() => admitEvidenceChild(fixture + '/outside', fixture))
    assert.throws(() => admitEvidenceChild(base + '/escape', fixture))
    assert.throws(() => admitEvidenceChild(evidence + '/../../escape', fixture))
    assert.throws(() => admitEvidenceChild(evidence + '-sibling/dir', fixture))
    await symlink(base, runDir + '/symlink-dir')
    assert.throws(() => admitEvidenceChild(runDir + '/symlink-dir', fixture))
    assert.throws(() =>
      admitEvidenceChild(runDir + '/symlink-dir/nested', fixture),
    )
    await rm(runDir + '/symlink-dir', { force: true })
    await writeFile(runDir + '/tracked-ledger.txt', 'test')
    git(
      'add',
      '-f',
      '.output/kobralink-rtc-evidence/run-123/tracked-ledger.txt',
    )
    assert.throws(() =>
      admitEvidenceChild(runDir + '/tracked-ledger.txt', fixture),
    )
    git(
      'rm',
      '--cached',
      '-f',
      '.output/kobralink-rtc-evidence/run-123/tracked-ledger.txt',
    )
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('verify-report CLI refuses a missing report without runtime admission', async () => {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(
    process.execPath,
    [
      'scripts/test-kobralink-rtc-acceptance.ts',
      '--verify-report',
      '.output/kobralink-rtc-evidence/missing-report.json',
    ],
    { cwd: checkout, encoding: 'utf8', env: { PATH: process.env.PATH } },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ENOENT/)
  assert.doesNotMatch(result.stderr, /Explicit admission/)
})
