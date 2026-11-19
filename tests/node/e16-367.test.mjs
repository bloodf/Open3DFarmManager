// Contract for `npm run desktop:check` (#367): the loopback network guard and
// the runner's preflight, step catalog, summary and failure rules. It does not
// run Playwright or the long steps; the combined acceptance run does.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  buildHermeticEnv,
  readViolations,
  pathWithoutDocker,
} from '../../scripts/desktop-network-env.ts'
import { STEPS } from '../../scripts/desktop-check-steps.ts'
import { isLoopbackHost } from '../../scripts/desktop-network-guard.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const guard = pathToFileURL(
  join(root, 'scripts/desktop-network-guard.mjs'),
).href
const work = realpathSync(mkdtempSync(join(tmpdir(), 'e16-367-')))
after(() => rmSync(work, { recursive: true, force: true }))

const cleanEnv = { ...process.env }
for (const name of [
  'NODE_TEST_CONTEXT',
  'OPENFARM_PG',
  'OPENFARM_SIM',
  'OPENFARM_BROWSER',
  'DOCKER_HOST',
  'NUXT_BAMBU_CLOUD',
])
  delete cleanEnv[name]

function guarded(code, name) {
  const log = join(work, `${name}.jsonl`)
  const result = spawnSync(
    process.execPath,
    ['--import', guard, '--input-type=module', '-e', code],
    {
      env: { ...cleanEnv, OPENFARM_NETWORK_GUARD_LOG: log },
      encoding: 'utf8',
      timeout: 60_000,
    },
  )
  assert.ifError(result.error)
  return { ...result, violations: readViolations(log) }
}

test('own interface addresses count as local, other private addresses do not', () => {
  const own = Object.values(networkInterfaces())
    .flat()
    .find((address) => address && !address.internal)
  if (own) assert.equal(isLoopbackHost(own.address), true, own.address)
  for (const host of ['10.255.255.254', '192.0.2.1', '198.51.100.7'])
    if (
      !Object.values(networkInterfaces())
        .flat()
        .some((address) => address?.address === host)
    )
      assert.equal(isLoopbackHost(host), false, host)
})

test('loopback classification accepts only loopback destinations', () => {
  for (const host of [
    undefined,
    '',
    'localhost',
    'LOCALHOST.',
    '127.0.0.1',
    '127.9.9.9',
    '0.0.0.0',
    '::1',
    '[::1]',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])
    assert.equal(isLoopbackHost(host), true, String(host))
  for (const host of [
    'example.com',
    'api.localhost.evil.example',
    '203.0.113.9',
    '192.0.2.20',
    '8.8.8.8',
    '169.254.169.254',
    '224.0.0.251',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    'host.docker.internal',
  ])
    assert.equal(isLoopbackHost(host), false, host)
})

test('guard rejects every non-loopback API and records each attempt', () => {
  const { status, stdout, violations } = guarded(
    `
import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
const seen = {}
const mark = (api) => (error) => { seen[api] = error?.code }
await fetch('https://example.com').catch(mark('fetch'))
await new Promise((done) => net.connect(443, 'example.com').on('error', (e) => { mark('net')(e); done() }))
await new Promise((done) => tls.connect(443, 'example.com').on('error', (e) => { mark('tls')(e); done() }))
try { http.get('http://example.com') } catch (e) { mark('http')(e) }
try { https.request('https://example.com') } catch (e) { mark('https')(e) }
await new Promise((done) => dns.lookup('example.com', (e) => { mark('dns')(e); done() }))
await dns.promises.resolve4('example.com').catch(mark('dns.promises'))
const udp = dgram.createSocket('udp4')
await new Promise((done) => udp.send('x', 5353, '224.0.0.251', (e) => { mark('dgram')(e); done() }))
udp.close()
try { new WebSocket('wss://example.com') } catch (e) { mark('websocket')(e) }
console.log(JSON.stringify(seen))
`,
    'apis',
  )
  assert.equal(status, 0)
  const seen = JSON.parse(stdout.trim().split('\n').at(-1))
  for (const api of [
    'fetch',
    'net',
    'tls',
    'http',
    'https',
    'dns',
    'dns.promises',
    'dgram',
    'websocket',
  ])
    assert.equal(seen[api], 'ERR_OPENFARM_NETWORK_GUARD', api)
  assert.ok(violations.length >= 9, `${violations.length} recorded`)
  assert.ok(
    violations.some((v) => v.api === 'fetch' && v.target === 'example.com'),
  )
})

test('guard lets loopback TCP, fetch, HTTP and Unix sockets through', () => {
  const socketPath = join(work, 'guard.sock')
  const { status, stdout, stderr, violations } = guarded(
    `
import http from 'node:http'
import net from 'node:net'
const server = http.createServer((_, response) => response.end('pong'))
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const viaFetch = await (await fetch('http://127.0.0.1:' + port)).text()
const viaLocalhost = await (await fetch('http://localhost:' + port)).text()
const viaHttp = await new Promise((resolve, reject) =>
  http.get({ host: '127.0.0.1', port }, (response) => {
    let body = ''
    response.on('data', (chunk) => (body += chunk))
    response.on('end', () => resolve(body))
  }).on('error', reject))
await new Promise((done) => server.close(done))
const unix = net.createServer((socket) => socket.end('unix'))
await new Promise((done) => unix.listen(${JSON.stringify(socketPath)}, done))
const viaUnix = await new Promise((resolve, reject) => {
  let body = ''
  net.connect({ path: ${JSON.stringify(socketPath)} })
    .on('data', (chunk) => (body += chunk))
    .on('end', () => resolve(body))
    .on('error', reject)
})
await new Promise((done) => unix.close(done))
console.log([viaFetch, viaLocalhost, viaHttp, viaUnix].join(','))
`,
    'loopback',
  )
  assert.equal(status, 0, stderr)
  assert.equal(stdout.trim(), 'pong,pong,pong,unix')
  assert.deepEqual(violations, [])
})

test('hermetic environment preloads the guard and forces offline tooling', () => {
  const shimDir = join(work, 'env-bin')
  const logPath = join(work, 'env.jsonl')
  const env = buildHermeticEnv({
    base: {
      PATH: '/usr/bin:/bin',
      NODE_OPTIONS: '--max-old-space-size=4096',
      OPENFARM_PG: 'docker',
      OPENFARM_SIM: 'docker',
      OPENFARM_BROWSER: 'bundled',
    },
    logPath,
    shimDir,
  })
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=4096/)
  assert.match(
    env.NODE_OPTIONS,
    /--import=file:\/\/.*desktop-network-guard\.mjs/,
  )
  assert.equal(env.OPENFARM_NETWORK_GUARD_LOG, logPath)
  assert.match(env.OPENFARM_NETWORK_GUARD_PRELOAD, /^--import=file:\/\//)
  assert.equal(env.npm_config_offline, 'true')
  assert.equal(env.OPENFARM_TIMEOUT_SCALE, '3')
  assert.equal(env.GOPROXY, 'off')
  assert.equal(env.GOTOOLCHAIN, 'local')
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '/nonexistent')
  for (const name of ['OPENFARM_PG', 'OPENFARM_SIM', 'OPENFARM_BROWSER'])
    assert.equal(env[name], undefined, name)
})

test('Docker is hidden from children while other tools in its directory stay', () => {
  const tools = join(work, 'tools-bin')
  mkdirSync(tools, { recursive: true })
  for (const name of ['docker', 'docker-compose', 'othertool']) {
    writeFileSync(join(tools, name), '#!/bin/sh\necho ran-$0\n')
    chmodSync(join(tools, name), 0o755)
  }
  const path = pathWithoutDocker(
    `${tools}:/usr/bin:/bin`,
    join(work, 'nodocker'),
  )
  const probe = (name) =>
    spawnSync(name, [], { env: { PATH: path }, encoding: 'utf8' })
  assert.equal(probe('docker').error?.code, 'ENOENT')
  assert.equal(probe('docker-compose').error?.code, 'ENOENT')
  assert.equal(probe('othertool').status, 0)
})

let runs = 0
function runner(args, env = {}) {
  // Logs go under the test's own directory so the run removes them.
  const logDir = join(work, `runner-logs-${runs++}`)
  const result = spawnSync(
    process.execPath,
    ['scripts/desktop-check.ts', '--log-dir', logDir, ...args],
    {
      cwd: root,
      env: { ...cleanEnv, ...env },
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  assert.ifError(result.error)
  return result
}

test('a deliberate outbound fetch fails the run even when the child swallows it', () => {
  const result = runner(['--guard-probe', '--only', 'network-guard-probe'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /network-guard-probe\s+FAILED/)
  assert.match(result.stdout, /Blocked non-loopback attempts:/)
  assert.match(result.stdout, /fetch -> example\.com/)
  assert.match(result.stdout, /desktop:check FAILED/)
})

test('the step catalog covers every required step in order', () => {
  assert.deepEqual(
    STEPS.map((step) => step.name),
    [
      'preflight',
      'lint',
      'typecheck',
      'vitest',
      'test-node',
      'rtsp-supervisor',
      'rtsp-framing',
      'build',
      'build-rtsp-ingest',
      'test-postgres',
      'test-e2e',
      'test-journey',
      'test-sim-farm',
      'app-smoke',
    ],
  )
  const commands = Object.fromEntries(
    STEPS.filter((step) => step.command).map((step) => [
      step.name,
      step.command.join(' '),
    ]),
  )
  assert.equal(commands['test-postgres'], 'npm run test:postgres')
  assert.equal(commands['test-e2e'], 'npm run test:e2e')
  assert.equal(commands['test-journey'], 'npm run test:journey')
  assert.equal(commands['test-sim-farm'], 'npm run test:sim-farm')
  assert.equal(commands['build-rtsp-ingest'], 'npm run build:rtsp-ingest')
  const scripts = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ).scripts
  assert.equal(scripts['desktop:check'], 'node scripts/desktop-check.ts')
  assert.equal(
    scripts['build:rtsp-ingest'],
    'node scripts/build-rtsp-ingest.mjs',
  )
  const listed = runner(['--list'])
  assert.equal(listed.status, 0)
  for (const step of STEPS)
    assert.ok(listed.stdout.includes(step.name), step.name)
})

/** Stub toolchain so the preflight verdict does not depend on this machine. */
function stubToolchain() {
  const bin = join(work, 'stub-bin')
  mkdirSync(bin, { recursive: true })
  const script = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  script('initdb', 'exit 0')
  script('postgres', 'exit 0')
  script('pg_ctl', 'echo "pg_ctl (PostgreSQL) 17.2"')
  const chrome = join(work, 'chrome-stub')
  writeFileSync(chrome, '#!/bin/sh\necho "Google Chrome 150.0.0.0"\n')
  chmodSync(chrome, 0o755)
  return {
    OPENFARM_PG_BIN: bin,
    OPENFARM_CHROME_PATH: chrome,
    RTSP_INGEST_GO_BIN: join(work, 'no-such-go'),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  }
}

test('preflight prints versions and a skipped step names its reason', () => {
  const result = runner(
    ['--only', 'preflight,build-rtsp-ingest'],
    stubToolchain(),
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, new RegExp(`node: ${process.version}`))
  assert.match(result.stdout, /npm: \d+\.\d+/)
  assert.match(result.stdout, /chrome: Google Chrome 150/)
  assert.match(result.stdout, /postgresql: pg_ctl \(PostgreSQL\) 17\.2/)
  assert.match(result.stdout, /preflight\s+PASSED\s+\S+ \S+/)
  assert.match(
    result.stdout,
    /build-rtsp-ingest\s+SKIPPED\s+\S+ \S+\s+rtsp-ingest build skipped: go is not available/,
  )
})

test('preflight fails when Docker would be used and skips the remaining steps', () => {
  const result = runner(['--only', 'preflight,lint'], {
    ...stubToolchain(),
    OPENFARM_PG: 'docker',
  })
  assert.equal(result.status, 1)
  assert.match(
    result.stdout,
    /OPENFARM_PG=docker: Docker or bundled browsers are not allowed/,
  )
  assert.match(result.stdout, /lint\s+SKIPPED\s+\S+ \S+\s+preflight failed/)
})

test('preflight rejects an unsupported Node and a missing Chrome', () => {
  const result = runner(['--only', 'preflight'], {
    ...stubToolchain(),
    OPENFARM_CHROME_PATH: join(work, 'missing-chrome'),
    NUXT_BAMBU_CLOUD: 'true',
  })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /Google Chrome not found/)
  assert.match(result.stdout, /NUXT_BAMBU_CLOUD must be off/)
})

test('the manual workflow runs the check on Node 22 without Docker or network', () => {
  const path = join(root, '.github/workflows/desktop-check.yml')
  assert.ok(existsSync(path))
  const workflow = readFileSync(path, 'utf8')
  assert.match(workflow, /^on: \[workflow_dispatch\]$/m)
  assert.doesNotMatch(workflow, /pull_request|push:|schedule:/)
  assert.match(workflow, /node-version: '22\.23\.5'/)
  assert.match(workflow, /desktop:check/)
  assert.match(workflow, /unshare/)
  assert.match(workflow, /docker/i)
  assert.match(workflow, /--require-isolated-network/)
})
