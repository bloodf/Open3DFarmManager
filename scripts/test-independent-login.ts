// Opt-in integration: built Node app, synthetic disposable PostgreSQL, local TLS and Chromium.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createTCPServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { createServer, request } from 'node:https'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, type Browser } from '@playwright/test'

const port = Number(process.env.LOGIN_SYNTHETIC_TEST_PORT)
const username = process.env.LOGIN_SYNTHETIC_TEST_USERNAME
const password = process.env.LOGIN_SYNTHETIC_TEST_PASSWORD
if (
  process.env.LOGIN_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !username ||
  !/^[a-z0-9_-]{3,64}$/.test(username) ||
  !password ||
  Buffer.byteLength(password) > 1024
)
  throw new Error(
    'Explicit disposable PostgreSQL port and synthetic credentials required',
  )

const app = fileURLToPath(
  new URL('../apps/farm/.output/server/index.mjs', import.meta.url),
)
await access(app)
const cookieName = '__Host-open3dfarmmanager-session'
const children: ChildProcess[] = []
const checks: string[] = []
const directory = await mkdtemp(join(tmpdir(), 'o3dfm-login-https-'))
let stage = 'setup'
let lastHTTP: { path: string; status: number } | undefined
let browser: Browser | undefined
let upstreamPort = 0
let closing: Promise<void> | undefined
const controller = new AbortController()
const proxy = createServer()
const sessionSecret = randomBytes(48).toString('base64url')
const execute = promisify(execFile)

async function bound<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Integration operation timed out')),
          milliseconds,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  )
  child.kill('SIGTERM')
  try {
    await bound(exited, 4000)
  } catch {
    child.kill('SIGKILL')
    await bound(exited, 3000)
  }
}
function cleanup(): Promise<void> {
  return (closing ??= (async () => {
    controller.abort()
    proxy.closeAllConnections()
    const results = await Promise.allSettled([
      ...(browser ? [bound(browser.close(), 5000)] : []),
      ...(proxy.listening
        ? [
            bound(
              new Promise<void>((resolve) => proxy.close(() => resolve())),
              3000,
            ),
          ]
        : []),
      ...children.map(stop),
    ])
    await rm(directory, { recursive: true, force: true })
    if (results.some((result) => result.status === 'rejected'))
      throw new Error(
        'An owned integration resource could not be confirmed stopped',
      )
  })())
}
const terminate = () => {
  void cleanup().finally(() => process.exit(130))
}
process.once('SIGINT', terminate)
process.once('SIGTERM', terminate)
const watchdog = setTimeout(() => {
  process.exitCode = 1
  console.error('Independent login integration exceeded its time budget')
  void cleanup().finally(() => process.exit(1))
}, 180_000)

async function unusedPort(): Promise<number> {
  const server = createTCPServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}
async function startApp(origin: string, database = 'fixture'): Promise<number> {
  const appPort = await unusedPort()
  const child = spawn(process.execPath, [app], {
    env: {
      ...process.env,
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(appPort),
      NUXT_AUTH_ENABLED: 'true',
      NUXT_AUTH_ORIGIN: origin,
      NUXT_AUTH_SESSION_SECRET: sessionSecret,
      NUXT_AUTH_DATABASE_URL: `postgres://login_fixture@127.0.0.1:${port}/${database}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  // Never print app output: error diagnostics can contain request headers or credentials.
  child.stdout?.resume()
  child.stderr?.resume()
  let spawnFailed = false
  child.once('error', () => {
    spawnFailed = true
  })
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    assert.ok(
      !spawnFailed && child.exitCode === null && child.signalCode === null,
      'Built app failed to start',
    )
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/healthz`, {
        signal: AbortSignal.timeout(1000),
      })
      await response.arrayBuffer()
      if (response.ok) return appPort
    } catch {
      /* The owned app may still be starting. */
    }
    await sleep(50, undefined, { signal: controller.signal })
  }
  throw new Error('Built app readiness timed out')
}
interface Reply {
  status: number
  body: string
  cookies: string[]
  cache: string | undefined
}
async function call(
  origin: string,
  path: string,
  options: {
    method?: string
    body?: string | Buffer
    headers?: Record<string, string>
  } = {},
): Promise<Reply> {
  return await new Promise((resolve, reject) => {
    const req = request(
      new URL(path, origin),
      {
        method: options.method ?? 'GET',
        rejectUnauthorized: false,
        headers: options.headers,
        signal: controller.signal,
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 128 * 1024) {
            res.destroy(new Error('Integration response exceeded bound'))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () => {
          lastHTTP = { path, status: res.statusCode ?? 0 }
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            cookies: res.headers['set-cookie'] ?? [],
            cache: res.headers['cache-control'],
          })
        })
      },
    )
    req.setTimeout(10_000, () =>
      req.destroy(new Error('HTTP integration request timed out')),
    )
    req.on('error', reject)
    req.end(options.body)
  })
}
function issuedCookie(reply: Reply): string {
  const cookie = [...reply.cookies]
    .reverse()
    .find(
      (value) =>
        value.startsWith(cookieName + '=') &&
        !value.startsWith(cookieName + '=;'),
    )
  assert.ok(cookie, 'Login must issue the independent cookie')
  for (const flag of [
    /;\s*Secure(?:;|$)/i,
    /;\s*HttpOnly(?:;|$)/i,
    /;\s*SameSite=Lax(?:;|$)/i,
    /;\s*Path=\/(?:;|$)/i,
  ])
    assert.ok(flag.test(cookie), 'Required session cookie attribute missing')
  assert.ok(!/;\s*Domain=/i.test(cookie), 'Session cookie must be host-only')
  const pair = cookie.split(';')[0]
  assert.ok(pair)
  return pair
}

try {
  await execute(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
    ],
    { timeout: 15_000, maxBuffer: 64 * 1024 },
  )
  proxy.setSecureContext({
    key: await readFile(join(directory, 'key.pem')),
    cert: await readFile(join(directory, 'cert.pem')),
  })
  proxy.requestTimeout = 15_000
  proxy.headersTimeout = 10_000
  proxy.on('request', (incoming, outgoing) => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
      },
    )
    upstream.setTimeout(12_000, () => upstream.destroy())
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502)
      outgoing.end()
    })
    incoming.on('aborted', () => upstream.destroy())
    outgoing.on('close', () => upstream.destroy())
    incoming.pipe(upstream)
  })
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', resolve)
  })
  const address = proxy.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `https://127.0.0.1:${address.port}`
  upstreamPort = await startApp(origin)
  const firstPort = upstreamPort
  const json = { origin, 'content-type': 'application/json' }
  const credentials = JSON.stringify({ username, password })
  const login = (body = credentials, headers: Record<string, string> = json) =>
    call(origin, '/api/auth/login', { method: 'POST', body, headers })

  assert.equal((await call(origin, '/api/auth/me')).status, 401)
  assert.equal(
    (await login(credentials, { 'content-type': 'application/json' })).status,
    403,
  )
  assert.equal(
    (await login(credentials, { ...json, origin: 'https://unrelated.invalid' }))
      .status,
    403,
  )
  const unknown = await login(
    JSON.stringify({
      username: 'missing_' + randomBytes(8).toString('hex'),
      password,
    }),
  )
  const wrong = await login(
    JSON.stringify({ username, password: randomBytes(24).toString('hex') }),
  )
  assert.equal(unknown.status, 401)
  assert.equal(wrong.status, 401)
  for (const response of [unknown, wrong]) {
    const body: unknown = JSON.parse(response.body)
    assert.ok(typeof body === 'object' && body !== null && 'message' in body)
    assert.equal(body.message, 'Usuário ou senha inválidos.')
  }
  assert.equal(
    (
      await login(
        '{"username":"fixture_user","username":"duplicate","password":"test"}',
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await call(origin, '/api/auth/login', {
        method: 'POST',
        headers: json,
        body: Buffer.from([0xc3, 0x28]),
      })
    ).status,
    400,
  )
  assert.equal((await login(' '.repeat(4097))).status, 413)
  checks.push('origin-generic-errors-duplicate-utf8-body-bounds')

  stage = 'http-cookie-lifecycle'
  const authenticated = await login()
  assert.equal(authenticated.status, 200)
  assert.equal(authenticated.cache, 'no-store')
  const oldCookie = issuedCookie(authenticated)
  assert.equal(
    (await call(origin, '/api/auth/me', { headers: { cookie: oldCookie } }))
      .status,
    200,
  )
  const rotated = await login(credentials, { ...json, cookie: oldCookie })
  assert.equal(rotated.status, 200)
  const cookie = issuedCookie(rotated)
  assert.ok(cookie !== oldCookie, 'Login must rotate the cookie')
  assert.equal(
    (await call(origin, '/api/auth/me', { headers: { cookie: oldCookie } }))
      .status,
    401,
  )
  const token = cookie.slice(cookie.indexOf('=') + 1)
  assert.equal(
    (
      await call(origin, '/api/auth/me', {
        headers: {
          'x-h3-session': token,
          'x-session': token,
          authorization: `Bearer ${token}`,
        },
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await call(origin, '/api/auth/me', {
        headers: { cookie: cookieName + '=tampered-' + token },
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await call(origin, '/api/auth/logout', {
        method: 'POST',
        headers: { origin: 'https://unrelated.invalid', cookie },
      })
    ).status,
    403,
  )
  assert.equal(
    (await call(origin, '/api/auth/me', { headers: { cookie } })).status,
    200,
  )
  assert.equal(
    (
      await call(origin, '/api/auth/logout', {
        method: 'POST',
        headers: { origin, cookie },
      })
    ).status,
    200,
  )
  assert.equal(
    (await call(origin, '/api/auth/me', { headers: { cookie } })).status,
    401,
  )
  checks.push(
    'cookie-attributes-login-rotation-header-tamper-logout-revocation',
  )

  stage = 'chromium-pages'
  browser = await chromium.launch({ headless: true, timeout: 15_000 })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.setDefaultNavigationTimeout(15_000)
  await page.goto(origin + '/entrar')
  assert.equal(await page.locator('html').getAttribute('lang'), 'pt-BR')
  await page.getByLabel('Usuário', { exact: true }).fill(username)
  await page.getByLabel('Senha', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.waitForURL(origin + '/')
  const browserCookie = (await context.cookies(origin)).find(
    (item) => item.name === cookieName,
  )
  assert.ok(browserCookie, 'Chromium must accept the secure host cookie')
  assert.ok(
    browserCookie.secure &&
      browserCookie.httpOnly &&
      browserCookie.sameSite === 'Lax',
  )
  assert.equal(browserCookie.domain, '127.0.0.1')
  const browserPair = cookieName + '=' + browserCookie.value
  assert.equal(
    await page.evaluate(async () => (await fetch('/api/auth/me')).status),
    200,
  )
  assert.ok(
    !(await page.evaluate(() => document.cookie)).includes(cookieName),
    'Cookie must be hidden from JavaScript',
  )
  await page.goto(origin + '/sair')
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click()
  await page.waitForURL(origin + '/')
  assert.equal(
    await page.evaluate(async () => (await fetch('/api/auth/me')).status),
    401,
  )
  assert.equal(
    (await call(origin, '/api/auth/me', { headers: { cookie: browserPair } }))
      .status,
    401,
  )
  await context.close()
  await browser.close()
  browser = undefined
  checks.push('chromium-real-pages-secure-host-cookie-login-logout')

  stage = 'shared-rate-limits'
  const bucket = 'limit_' + randomBytes(8).toString('hex')
  const invalid = JSON.stringify({
    username: bucket,
    password: 'synthetic-invalid-password',
  })
  for (let index = 0; index < 8; index++)
    assert.equal((await login(invalid)).status, 401)
  upstreamPort = await startApp(origin)
  for (let index = 0; index < 7; index++)
    assert.equal((await login(invalid)).status, 401)
  assert.equal((await login(invalid)).status, 429)
  upstreamPort = firstPort
  assert.equal((await login(invalid)).status, 429)
  checks.push('account-rate-limit-shared-by-independent-node-processes')
  const secondApp = children[1]
  assert.ok(secondApp)
  await stop(secondApp)

  stage = 'unavailable-database'
  const beforeFailure = await login()
  assert.equal(beforeFailure.status, 200)
  const outageCookie = issuedCookie(beforeFailure)
  const firstApp = children[0]
  assert.ok(firstApp)
  await stop(firstApp)
  // This database does not exist: no parent database is stopped or modified.
  upstreamPort = await startApp(
    origin,
    'missing_' + randomBytes(8).toString('hex'),
  )
  assert.equal(
    (await call(origin, '/api/auth/me', { headers: { cookie: outageCookie } }))
      .status,
    503,
  )
  assert.equal((await login()).status, 503)
  checks.push('unavailable-database-fails-closed-with-valid-cookie')
} catch {
  process.exitCode = 1
  console.error(
    JSON.stringify({
      result: 'failed',
      stage,
      lastHTTP,
      completedChecks: checks,
      detail:
        'Integration assertion or operation failed; sensitive diagnostics suppressed',
    }),
  )
} finally {
  clearTimeout(watchdog)
  await cleanup().catch(() => {
    process.exitCode = 1
    console.error(
      'Owned integration cleanup incomplete; inspect task resources',
    )
  })
  process.removeListener('SIGINT', terminate)
  process.removeListener('SIGTERM', terminate)
}
if (!process.exitCode)
  console.log(
    JSON.stringify({
      result: 'passed',
      checks,
      cleanup: 'owned-browser-apps-proxy-certificate-directory-removed',
    }),
  )
