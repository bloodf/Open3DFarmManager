import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { registrationAdmission } from '../helpers/kobralink-rtc/admission.ts'
import {
  captureBodies,
  uniqueMatch,
} from '../helpers/kobralink-rtc/cdp-body.ts'
import { instrumentPage } from '../helpers/kobralink-rtc/observe.ts'

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
  reportSections,
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

test('a report built from a complete passing run verifies', () => {
  const summary = aggregate(everyCheck())
  assert.equal(summary.status, 'pass')
  const report = {
    status: summary.status,
    complete: true,
    ...reportSections(summary.results),
  }
  assert.deepEqual(verifyReport(report), [])
  // The think-time addition is never folded into the twelve.
  assert.equal('think_time_lease_renewal' in report.qualifications, false)
  assert.equal(report.additional.think_time_lease_renewal, 'pass')
})

test('verify-report refuses a think-time refusal that is not recoverable', () => {
  const report = passing()
  report.additional.think_time_lease_renewal = 'fail'
  assert.deepEqual(verifyReport(report), ['think_time_lease_renewal is fail'])
  assert.deepEqual(verifyReport({ ...passing(), additional: undefined }), [
    'think_time_lease_renewal is absent',
  ])
})

test('the committed single-UI result is read strictly, whatever it says', async () => {
  const { readFile } = await import('node:fs/promises')
  const { verifySingleUi } =
    await import('../helpers/kobralink-rtc/single-ui.ts')
  const report: unknown = JSON.parse(
    await readFile(
      new URL(
        '../../docs/compatibility/kobralink-rtc-acceptance.json',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  const problems = verifySingleUi(report)
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

test('capture pairs only exactly one unclaimed request with the same start', () => {
  const a = { startMs: 1000, claimed: false }
  const b = { startMs: 1000.01, claimed: false }
  const c = { startMs: 1000.3, claimed: false }
  assert.equal(uniqueMatch([a, c], 1000), a)
  assert.equal(uniqueMatch([a, c], 1000.3), c)
  // Two candidates on the same stamp: never attribute either body.
  assert.equal(uniqueMatch([a, b, c], 1000), 'ambiguous')
  // No candidate or an already claimed one: no body.
  assert.equal(uniqueMatch([a, c], 1000.15), null)
  assert.equal(uniqueMatch([{ ...a, claimed: true }, c], 1000), null)
})

test('network capture reads only complete undrained bodies, never a prefix', async () => {
  const SECRET = 'secret-after-retained-prefix'
  const server = createServer((req, res) => {
    if (req.url === '/') return res.end('<html>ok</html>')
    res.statusCode = 403
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/complete') return res.end('{"denied":"complete"}')
    if (req.url === '/api/encoded') {
      // The declared length counts compressed wire bytes. Here it equals the
      // decoded size while the wire is still short of it: unfinished, so the
      // decoded bytes must never be taken as the complete body.
      const decoded = '{"denied":"' + 'e'.repeat(400) + '"}'
      const wire = gzipSync(decoded)
      res.setHeader('content-encoding', 'gzip')
      res.setHeader('content-length', String(decoded.length))
      res.write(wire)
      return
    }
    if (req.url === '/api/short') {
      res.setHeader('content-length', '100')
      res.write('{"partial":')
      return
    }
    // Chunked, no Content-Length, finished, larger than the capture bound.
    res.write('x'.repeat(1_100_000))
    res.end(SECRET)
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(origin + '/')
    const network = await captureBodies(page, origin)
    const takes = new Map<string, ReturnType<typeof network.take>>()
    const twice: ReturnType<typeof network.take>[] = []
    page.on('response', (res) => {
      const path = new URL(res.url()).pathname
      if (!path.startsWith('/api/')) return
      const args = [
        res.request().method(),
        res.url(),
        res.status(),
        res.request().timing().startTime,
      ] as const
      takes.set(path, network.take(...args))
      if (path === '/api/complete') twice.push(network.take(...args))
    })
    // The page reads only statuses: no body is ever drained by page code.
    for (const path of [
      '/api/complete',
      '/api/encoded',
      '/api/short',
      '/api/overflow',
    ])
      void page
        .evaluate(async (u) => (await fetch(u)).status, origin + path)
        .catch(() => 0)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const read = async (path: string) => (await takes.get(path))!.read()
    const done = await read('/api/complete')
    assert.equal(done.body, '{"denied":"complete"}')
    const encoded = await read('/api/encoded')
    assert.equal(encoded.facts.encoded, true)
    assert.equal(encoded.facts.finished, false)
    assert.equal(encoded.body, null)
    const short = await read('/api/short')
    assert.equal(short.body, null)
    assert.equal(short.facts.declaredLength, 100)
    assert.ok(short.facts.receivedBytes < 100)
    const overflow = await read('/api/overflow')
    assert.equal(overflow.body, null)
    assert.equal(overflow.facts.truncated, true)
    // The same request is never claimed a second time.
    assert.equal((await twice[0]!).read().body, null)
  } finally {
    await browser.close()
    server.closeAllConnections()
    server.close()
  }
})

test('network capture keeps a finished body the page navigated away from', async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/page')) return res.end('<html>ok</html>')
    res.setHeader('content-type', 'application/json')
    res.end('{"me":"finished-then-navigated"}')
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(origin + '/page')
    const network = await captureBodies(page, origin)
    let take: ReturnType<typeof network.take> | undefined
    page.on('response', (res) => {
      if (!res.url().endsWith('/api/me')) return
      take = network.take(
        res.request().method(),
        res.url(),
        res.status(),
        res.request().timing().startTime,
      )
    })
    // Run e5d289c7: the page read the body, the load finished before any
    // streaming began, and a navigation followed before the observer read it.
    await page.evaluate(async () => {
      await (await fetch('/api/me')).text()
      await new Promise((resolve) => setTimeout(resolve, 30))
      location.href = '/page?next'
    })
    await page.waitForURL(/next/)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.ok(take)
    const captured = (await take).read()
    assert.equal(captured.body, '{"me":"finished-then-navigated"}')
    assert.equal(captured.facts.finished, true)
    assert.equal(captured.facts.fetched, true)
  } finally {
    await browser.close()
    server.closeAllConnections()
    server.close()
  }
})

test('a body read in the same tick as a reload is still captured whole', async () => {
  // Run b83850cd: /api/auth/me finished, the page reloaded at once and
  // Chromium had dropped the body before `getResponseBody` reached it.
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/page')) return res.end('<html>ok</html>')
    res.setHeader('content-type', 'application/json')
    res.end('{"me":"read-then-reloaded"}')
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const evidence = await mkdtemp(join(tmpdir(), 'kobralink-observe-'))
  const browser = await chromium.launch({ headless: true })
  try {
    for (let round = 0; round < 5; round++) {
      const page = await browser.newPage()
      await page.goto(origin + '/page')
      const observer = await instrumentPage({
        page,
        label: 'owner',
        evidence,
        origin,
        t0: Date.now(),
      })
      await page
        .evaluate(async () => {
          const reads = [1, 2, 3, 4].map(() =>
            fetch('/api/me').then((r) => r.text()),
          )
          await Promise.all(reads)
          location.reload()
        })
        .catch(() => {})
      await page.waitForLoadState('load')
      const scan = await observer.scan([])
      assert.equal(scan.unread, 0, `round ${round}: a finished body was lost`)
      assert.equal(scan.aborted, 0)
      assert.ok(scan.read >= 4)
      await page.close()
    }
  } finally {
    await browser.close()
    server.closeAllConnections()
    server.close()
    await rm(evidence, { recursive: true, force: true })
  }
})

test('single-UI result is derived only from manifest-matching run files', async () => {
  const { createHash } = await import('node:crypto')
  const { buildSingleUiResult, verifySingleUi, SINGLE_UI_REQUIRED } =
    await import('../helpers/kobralink-rtc/single-ui.ts')
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const line = (check: string, ok = true) => {
    const [qualification, id] = check.split('/')
    return JSON.stringify({ world: 'positive', qualification, id, ok })
  }
  const build = (lines: string[], exit = 0, tamper = false) => {
    const files = {
      'final-report.json': JSON.stringify({
        head: 'a'.repeat(40),
        run: '6bf9caa0-7707-4e38-81b7-33e27563979b',
        sourceSha256: 'b'.repeat(64),
        outputSha256: 'c'.repeat(64),
        worlds: { positive: { exit } },
      }),
      'positive/checks.jsonl': lines.join('\n') + '\n',
      'runner-checks.jsonl': '',
    }
    const manifest = Object.entries(files)
      .map(([name, text]) => `${sha(tamper ? text + 'x' : text)}  ${name}`)
      .join('\n')
    return buildSingleUiResult({ manifest, files })
  }
  const all = SINGLE_UI_REQUIRED.map((check) => line(check))
  const passing = build([
    ...all,
    line('browser_secrets_absent/browser-inspection-complete', false),
  ])
  assert.equal(passing.status, 'pass')
  assert.deepEqual(verifySingleUi(passing), [])
  // A failed repetition, a missing check or a failed world never passes.
  const failed = build([...all, line(SINGLE_UI_REQUIRED[7], false)])
  assert.equal(failed.status, 'fail')
  assert.ok(verifySingleUi(failed).length > 0)
  assert.ok(verifySingleUi(build(all.slice(1))).length > 0)
  assert.ok(verifySingleUi(build(all, 1)).length > 0)
  // Files that do not match the run's own manifest are refused.
  assert.throws(() => build(all, 0, true), /does not match the run manifest/)
  // A hand-edited pass without recorded checks is refused.
  assert.ok(verifySingleUi({ ...passing, recorded: [] }).length > 0)
})
