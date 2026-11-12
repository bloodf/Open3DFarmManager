import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type PlaywrightWorkerArgs,
} from '@playwright/test'
import postgres from 'postgres'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'

// Real built app + disposable migrated PostgreSQL behind a loopback TLS proxy.
// Run with playwright.auth-session.config.ts; skipped in the default e2e run.
const env = process.env
test.skip(
  env.AUTH_E2E_DISPOSABLE !== 'yes',
  'Requires disposable HTTPS and PostgreSQL fixture',
)

const COOKIE = '__Host-open3dfarmmanager-session'
const IDLE_MS = 30 * 60 * 1000
const LIFETIME_MS = 8 * 60 * 60 * 1000
const password = 'synthetic-password-' + randomBytes(8).toString('hex')
const origin = `https://127.0.0.1:${env.AUTH_E2E_TLS_PORT}`
const sql = postgres({
  host: '127.0.0.1',
  port: Number(env.AUTH_E2E_DB_PORT),
  database: 'fixture',
  username: 'fixture',
  ssl: false,
  max: 2,
  connect_timeout: 3,
})
let passwordHash = ''

test.beforeAll(async () => {
  passwordHash = await hashPassword(password)
  // The app connects as a least-privilege login role; create it once.
  const [role] =
    await sql`SELECT 1 FROM pg_roles WHERE rolname = 'o3dfm_w05_auth'`
  if (!role)
    await sql`CREATE ROLE o3dfm_w05_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE IN ROLE farm_password_auth`
})
test.beforeEach(async () => {
  await sql`DELETE FROM farm.auth_rate_limits`
})
test.afterAll(async () => {
  await sql.end({ timeout: 3 })
})

async function account(disabled = false) {
  const id = randomUUID()
  const username = 'w05_' + randomBytes(8).toString('hex')
  await sql`INSERT INTO farm.session_accounts (id, disabled) VALUES (${id}, ${disabled})`
  await sql`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${id}, ${username}, ${passwordHash})`
  return { id, username }
}
const post = (request: APIRequestContext, path: string, data: unknown) =>
  request.post(path, { data, headers: { origin } })
const login = (
  request: APIRequestContext,
  username: string,
  secret = password,
) => post(request, '/api/auth/login', { username, password: secret })
const me = (request: APIRequestContext) => request.get('/api/auth/me')
const failures = (
  request: APIRequestContext,
  username: string,
  count: number,
) =>
  Promise.all(
    Array.from({ length: count }, () =>
      login(request, username, 'wrong-' + randomBytes(6).toString('hex')),
    ),
  )
async function cookieOf(request: APIRequestContext): Promise<string> {
  const found = (await request.storageState()).cookies.find(
    (item) => item.name === COOKIE,
  )
  expect(found).toBeDefined()
  return `${COOKIE}=${found?.value}`
}
async function withCookie<T>(
  playwright: PlaywrightWorkerArgs['playwright'],
  cookie: string,
  use: (request: APIRequestContext) => Promise<T>,
): Promise<T> {
  const replay: APIRequestContext = await playwright.request.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { cookie },
  })
  try {
    return await use(replay)
  } finally {
    await replay.dispose()
  }
}
/** The immutability trigger blocks time travel; replica mode bypasses it on this disposable database only. */
async function rewriteSession(
  accountId: string,
  times: { createdAt: number; lastSeenAt: number; absoluteExpiresAt: number },
) {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`
    await tx`UPDATE farm.account_sessions SET created_at = ${times.createdAt}, last_seen_at = ${times.lastSeenAt}, absolute_expires_at = ${times.absoluteExpiresAt} WHERE account_id = ${accountId}`
  })
}
const sessionRow = async (accountId: string) =>
  (
    await sql`SELECT last_seen_at::float8 AS "lastSeenAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE account_id = ${accountId}`
  )[0]
async function expectBody(response: APIResponse, status: number) {
  expect(response.status()).toBe(status)
  return await response.json()
}

test.describe('login rate limit and lockout', () => {
  test('unknown user and wrong password get the same 401 body', async ({
    request,
  }) => {
    const { username } = await account()
    const unknown = await login(
      request,
      'w05_missing_' + randomBytes(4).toString('hex'),
    )
    const wrong = await login(request, username, 'wrong-password')
    expect(await expectBody(unknown, 401)).toEqual(await expectBody(wrong, 401))
  })

  test('disabled account with the right password gets the wrong-password 401', async ({
    request,
  }) => {
    const disabled = await account(true)
    const active = await account()
    const blocked = await login(request, disabled.username)
    const wrong = await login(request, active.username, 'wrong-password')
    expect(await expectBody(blocked, 401)).toEqual(await expectBody(wrong, 401))
  })

  test('sixteenth failed attempt for a username is rejected with 429', async ({
    request,
  }) => {
    const { username } = await account()
    const first = await failures(request, username, 15)
    expect(first.map((reply) => reply.status())).toEqual(Array(15).fill(401))
    expect((await login(request, username, 'wrong')).status()).toBe(429)
  })

  test('locked username rejects the correct password', async ({ request }) => {
    const { username } = await account()
    await failures(request, username, 15)
    const reply = await login(request, username)
    expect(reply.status()).toBe(429)
    expect((await me(request)).status()).toBe(401)
  })

  test('nonexistent username locks out with the same 429 body as a real one', async ({
    request,
  }) => {
    const real = await account()
    const ghost = 'w05_ghost_' + randomBytes(4).toString('hex')
    await failures(request, real.username, 15)
    await failures(request, ghost, 15)
    const lockedReal = await login(request, real.username, 'wrong')
    const lockedGhost = await login(request, ghost, 'wrong')
    expect(await expectBody(lockedReal, 429)).toEqual(
      await expectBody(lockedGhost, 429),
    )
  })

  test('lockout of one username does not block another account', async ({
    request,
  }) => {
    const locked = await account()
    const other = await account()
    await failures(request, locked.username, 15)
    expect((await login(request, locked.username, 'wrong')).status()).toBe(429)
    expect((await login(request, other.username)).status()).toBe(200)
  })

  test('lockout lifts once the fifteen minute window has elapsed', async ({
    request,
  }) => {
    const { username } = await account()
    await failures(request, username, 15)
    expect((await login(request, username)).status()).toBe(429)
    await sql`UPDATE farm.auth_rate_limits SET window_start = clock_timestamp() - interval '16 minutes'`
    expect((await login(request, username)).status()).toBe(200)
  })

  test('sixty-first request from one address is rejected whatever the username', async ({
    request,
  }) => {
    // Malformed bodies still consume the address bucket but skip password hashing.
    const replies: number[] = []
    for (let index = 0; index < 60; index++)
      replies.push((await post(request, '/api/auth/login', {})).status())
    expect(new Set(replies)).toEqual(new Set([400]))
    const { username } = await account()
    expect((await login(request, username)).status()).toBe(429)
  })

  test('browser shows the same generic message for unknown user and wrong password', async ({
    page,
  }) => {
    const { username } = await account()
    const submit = async (name: string) => {
      await page.goto('/entrar')
      await page.getByLabel('Usuário', { exact: true }).fill(name)
      await page.getByLabel('Senha', { exact: true }).fill('wrong-password')
      await page.getByRole('button', { name: 'Entrar', exact: true }).click()
      const alert = page.getByRole('alert')
      await expect(alert).toContainText('Usuário ou senha inválidos')
      return await alert.innerText()
    }
    const wrong = await submit(username)
    const unknown = await submit(
      'w05_missing_' + randomBytes(4).toString('hex'),
    )
    expect(unknown).toBe(wrong)
  })

  test('browser lockout shows a generic retry message and stays signed out', async ({
    page,
    request,
  }) => {
    const { username } = await account()
    await failures(request, username, 15)
    await page.goto('/entrar')
    await page.getByLabel('Usuário', { exact: true }).fill(username)
    await page.getByLabel('Senha', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText(
      'Muitas tentativas. Aguarde um pouco antes de tentar novamente.',
    )
    await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('')
    await expect(page).toHaveURL(/\/entrar$/)
    expect(
      (await page.context().cookies()).some((c) => c.name === COOKIE),
    ).toBe(false)
  })
})

test.describe('session expiry, rotation and revocation', () => {
  test('login while holding a cookie rotates it and kills the old one', async ({
    request,
    playwright,
  }) => {
    const { username } = await account()
    await login(request, username)
    const oldCookie = await cookieOf(request)
    expect((await login(request, username)).status()).toBe(200)
    const newCookie = await cookieOf(request)
    expect(newCookie).not.toBe(oldCookie)
    expect((await me(request)).status()).toBe(200)
    const replay = await withCookie(playwright, oldCookie, async (ctx) =>
      (await me(ctx)).status(),
    )
    expect(replay).toBe(401)
  })

  test('logout makes the previous cookie unusable on replay', async ({
    request,
    playwright,
  }) => {
    const { username } = await account()
    await login(request, username)
    const cookie = await cookieOf(request)
    expect((await post(request, '/api/auth/logout', {})).status()).toBe(200)
    const replay = await withCookie(playwright, cookie, async (ctx) =>
      (await me(ctx)).status(),
    )
    expect(replay).toBe(401)
  })

  test('browser logout revokes the session in the database', async ({
    page,
  }) => {
    const { id, username } = await account()
    await page.goto('/entrar')
    await page.getByLabel('Usuário', { exact: true }).fill(username)
    await page.getByLabel('Senha', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await expect(page).toHaveURL(`${origin}/`)
    expect((await sessionRow(id))?.revokedAt).toBeNull()
    await page.goto('/sair')
    await page
      .getByRole('button', { name: 'Sair da conta', exact: true })
      .click()
    await expect(page).toHaveURL(`${origin}/`)
    expect(
      await page.evaluate(async () => (await fetch('/api/auth/me')).status),
    ).toBe(401)
    expect((await sessionRow(id))?.revokedAt).not.toBeNull()
  })

  test('session idle for more than thirty minutes is rejected and revoked', async ({
    request,
  }) => {
    const { id, username } = await account()
    await login(request, username)
    const now = Date.now()
    await rewriteSession(id, {
      createdAt: now - 3 * 3600_000,
      lastSeenAt: now - IDLE_MS - 60_000,
      absoluteExpiresAt: now - 3 * 3600_000 + LIFETIME_MS,
    })
    expect((await me(request)).status()).toBe(401)
    expect((await sessionRow(id))?.revokedAt).not.toBeNull()
  })

  test('session past its eight hour lifetime is rejected even when recently active', async ({
    request,
  }) => {
    const { id, username } = await account()
    await login(request, username)
    const now = Date.now()
    await rewriteSession(id, {
      createdAt: now - LIFETIME_MS - 3600_000,
      lastSeenAt: now - 120_000,
      absoluteExpiresAt: now - 60_000,
    })
    expect((await me(request)).status()).toBe(401)
  })

  test('activity inside the idle window keeps the session and refreshes last seen', async ({
    request,
  }) => {
    const { id, username } = await account()
    await login(request, username)
    const now = Date.now()
    const seen = now - 25 * 60_000
    await rewriteSession(id, {
      createdAt: now - 2 * 3600_000,
      lastSeenAt: seen,
      absoluteExpiresAt: now + 3600_000,
    })
    expect((await me(request)).status()).toBe(200)
    expect((await sessionRow(id))?.lastSeenAt).toBeGreaterThan(seen)
  })

  test('expired session cannot be revived by a later request', async ({
    request,
  }) => {
    const { id, username } = await account()
    await login(request, username)
    const now = Date.now()
    await rewriteSession(id, {
      createdAt: now - 3 * 3600_000,
      lastSeenAt: now - IDLE_MS - 60_000,
      absoluteExpiresAt: now + 3600_000,
    })
    expect((await me(request)).status()).toBe(401)
    expect((await me(request)).status()).toBe(401)
  })

  test('bumping the account session version rejects existing sessions but allows a new login', async ({
    request,
  }) => {
    const { id, username } = await account()
    await login(request, username)
    expect((await me(request)).status()).toBe(200)
    await sql`UPDATE farm.session_accounts SET session_version = session_version + 1 WHERE id = ${id}`
    expect((await me(request)).status()).toBe(401)
    expect((await login(request, username)).status()).toBe(200)
    expect((await me(request)).status()).toBe(200)
  })

  test('disabling the account rejects its live session', async ({
    request,
  }) => {
    const { id, username } = await account()
    await login(request, username)
    await sql`UPDATE farm.session_accounts SET disabled = true WHERE id = ${id}`
    expect((await me(request)).status()).toBe(401)
  })

  test('browser with an expired session is told to sign in again and sees no farm data', async ({
    page,
  }) => {
    const { id, username } = await account()
    await page.goto('/entrar')
    await page.getByLabel('Usuário', { exact: true }).fill(username)
    await page.getByLabel('Senha', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await expect(page).toHaveURL(`${origin}/`)
    const now = Date.now()
    await rewriteSession(id, {
      createdAt: now - 3 * 3600_000,
      lastSeenAt: now - IDLE_MS - 60_000,
      absoluteExpiresAt: now + 3600_000,
    })
    await page.goto('/dispositivos')
    await expect(page.getByRole('alert')).toContainText(
      'Entre novamente e atualize suas farms',
    )
  })
})
