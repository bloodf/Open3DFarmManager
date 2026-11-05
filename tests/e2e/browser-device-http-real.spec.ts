import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

const env = process.env
test.skip(
  env.BROWSER_DEVICE_HTTP_TEST_DISPOSABLE !== 'yes',
  'Requires disposable HTTPS and PostgreSQL fixture',
)

async function login(page: Page, username: string, secret: string) {
  await page.goto('/entrar')
  await page.locator('#username').fill(username)
  await page.locator('#password').fill(secret)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(
    page.getByRole('link', { name: 'Dispositivos do navegador' }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Dispositivos do navegador' }).click()
}
async function logout(page: Page) {
  await page.goto('/sair')
  await page.getByRole('button', { name: 'Sair da conta' }).click()
  await expect(page).toHaveURL(/\/$/)
}

test('real HTTPS login, persistent key enrollment, approval, recovery and terminal revocation', async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(90000)
  const farm = env.BROWSER_DEVICE_HTTP_TEST_FARM_ID
  const owner = env.BROWSER_DEVICE_HTTP_TEST_OWNER_USERNAME
  const viewer = env.BROWSER_DEVICE_HTTP_TEST_VIEWER_USERNAME
  const adminUser = env.BROWSER_DEVICE_HTTP_TEST_ADMIN_USERNAME
  const originUrl = env.BROWSER_DEVICE_HTTP_TEST_ORIGIN
  const ownerAccount = env.BROWSER_DEVICE_HTTP_TEST_OWNER_ACCOUNT
  const password = env.BROWSER_DEVICE_HTTP_TEST_PASSWORD
  const port = Number(env.BROWSER_DEVICE_HTTP_SYNTHETIC_TEST_PORT)
  if (
    !farm ||
    !owner ||
    !viewer ||
    !adminUser ||
    !originUrl ||
    !ownerAccount ||
    !password ||
    !Number.isInteger(port)
  )
    throw new Error('Disposable browser fixture required')
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: 'fixture',
    ssl: false,
    max: 1,
    connect_timeout: 3,
  })
  let proofSession = '',
    challengeId = '',
    proofBody = ''
  page.on('request', (request) => {
    if (request.url().endsWith('/api/browser-devices/proofs'))
      proofBody = request.postData() ?? ''
  })
  page.on('response', async (response) => {
    if (
      response.url().endsWith('/api/browser-devices/challenges') &&
      response.ok()
    ) {
      const body = await response.json()
      proofSession = body.challenge.session_id
      challengeId = body.challenge.challenge_id
    }
  })
  try {
    await login(page, owner, password)
    const cookies = await context.cookies()
    const cookie = cookies.find(
      (c) => c.name === '__Host-open3dfarmmanager-session',
    )
    expect(cookie).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    })
    expect(cookie?.domain).toBe(new URL(page.url()).hostname)
    await page.locator('#device-farm').selectOption(farm)
    await page
      .getByRole('button', { name: 'Criar chave e solicitar cadastro' })
      .click()
    await expect(
      page.getByText('Posse confirmada.', { exact: false }),
    ).toBeVisible()
    const fingerprint = await page.locator('li code').first().textContent()
    expect(fingerprint).toBeTruthy()
    const rows =
      await sql`SELECT k.status,k.proof_at,c.session_id,c.challenge->>'session_id' AS public_id,c.consumed_at,c.outcome FROM farm.browser_device_keys k JOIN farm.browser_device_challenges c ON c.key_id=k.key_id WHERE c.challenge_id=${challengeId}::uuid`
    expect(rows[0]?.status).toBe('pending')
    expect(rows[0]?.outcome).toBe('verified')
    expect(rows[0]?.proof_at).not.toBeNull()
    expect(rows[0]?.public_id).toBe(proofSession)
    expect(rows[0]?.session_id).not.toBe(proofSession)
    expect(proofBody).toBeTruthy()
    const origin = new URL(page.url()).origin
    const replay = await context.request.post(
      origin + '/api/browser-devices/proofs',
      {
        headers: { origin, 'content-type': 'application/json' },
        data: proofBody,
      },
    )
    expect(replay.status()).toBe(403)
    const wrongOrigin = await context.request.post(
      origin + '/api/browser-devices/challenges',
      {
        headers: {
          origin: 'https://other.example',
          'content-type': 'application/json',
        },
        data: {},
      },
    )
    expect(wrongOrigin.status()).toBe(403)
    const extra = await context.request.post(
      origin + '/api/browser-devices/challenges',
      {
        headers: { origin, 'content-type': 'application/json' },
        data: {
          farm_id: farm,
          public_key: {},
          purpose: 'recover',
          account_id: 'other',
        },
      },
    )
    expect(extra.status()).toBe(400)
    const foreign = await context.request.get(
      origin +
        '/api/browser-devices?farm_id=' +
        env.BROWSER_DEVICE_HTTP_TEST_OTHER_FARM_ID,
    )
    expect(foreign.status()).toBe(403)
    const privateExportable = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('open3dfarmmanager-device-keys')
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
      })
      const key = await new Promise<CryptoKey>((resolve, reject) => {
        const r = db.transaction('keys').objectStore('keys').getAll()
        r.onsuccess = () => resolve(r.result[0].privateKey)
        r.onerror = () => reject(r.error)
      })
      db.close()
      try {
        await crypto.subtle.exportKey('pkcs8', key)
        return true
      } catch {
        return false
      }
    })
    expect(privateExportable).toBe(false)
    const adminContext = await browser.newContext({
      baseURL: originUrl,
      ignoreHTTPSErrors: true,
    })
    try {
      const adminPage = await adminContext.newPage()
      await login(adminPage, adminUser, password)
      await adminPage.locator('#device-farm').selectOption(farm)
      await adminPage.locator('#fingerprint-confirmation').fill(fingerprint!)
      await adminPage
        .getByRole('button', { name: 'Aprovar dispositivo' })
        .click()
      await expect(adminPage.getByText('Dispositivo aprovado.')).toBeVisible()
    } finally {
      await adminContext.close()
    }
    await page.reload()
    await page.locator('#device-farm').selectOption(farm)
    await expect(page.locator('li code').first()).toHaveText(fingerprint!)
    await logout(page)
    await login(page, owner, password)
    await page.locator('#device-farm').selectOption(farm)
    await page
      .getByRole('button', { name: 'Confirmar posse da chave existente' })
      .click()
    await expect(
      page.getByText('Posse confirmada nesta sessão.', { exact: false }),
    ).toBeVisible()
    await sql`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${farm}::uuid AND account_id=${ownerAccount}`
    await page.reload()
    await page.locator('#device-farm').selectOption(farm)
    await expect(page.locator('#fingerprint-confirmation')).toHaveCount(0)
    await sql`UPDATE farm.memberships SET role='owner' WHERE farm_id=${farm}::uuid AND account_id=${ownerAccount}`
    await page.reload()
    await page.locator('#device-farm').selectOption(farm)
    await page.locator('#fingerprint-confirmation').fill(fingerprint!)
    await page.getByRole('button', { name: 'Revogar definitivamente' }).click()
    await expect(
      page.getByText('Dispositivo revogado definitivamente.'),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Confirmar posse da chave existente' }),
    ).toBeDisabled()
    await page
      .getByRole('button', { name: 'Criar chave e solicitar cadastro' })
      .click()
    await expect(
      page.getByText('Posse confirmada.', { exact: false }),
    ).toBeVisible()
    const keyStatuses =
      await sql`SELECT status FROM farm.browser_device_keys WHERE account_id=${ownerAccount} AND farm_id=${farm}::uuid ORDER BY status`
    expect(keyStatuses.map((row) => row.status).sort()).toEqual([
      'pending',
      'revoked',
    ])
    await logout(page)
    await login(page, viewer, password)
    await page.locator('#device-farm').selectOption(farm)
    await expect(
      page.getByText('Nenhuma chave local', { exact: false }),
    ).toBeVisible()
    const persisted =
      await sql`SELECT count(*)::int AS n FROM farm.browser_device_keys WHERE account_id=${ownerAccount} AND farm_id=${farm}::uuid`
    expect(persisted[0]?.n).toBe(2)
  } finally {
    await sql.end({ timeout: 3 })
  }
})
