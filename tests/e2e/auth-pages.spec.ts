import { test, expect } from '@playwright/test'

test('login rejects credentials without retaining the password or following return URLs', async ({
  page,
}) => {
  let requests = 0
  await page.route('**/api/auth/login', async (route) => {
    requests++
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({
      username: 'fixture_user',
      password: 'synthetic-password',
    })
    await route.fulfill({
      status: 401,
      json: { message: 'private synthetic detail' },
    })
  })
  await page.goto('/entrar?return=https://example.invalid')
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })
  await page.getByLabel('Usuário', { exact: true }).fill('fixture_user')
  await page.getByLabel('Senha', { exact: true }).fill('synthetic-password')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Usuário ou senha inválidos',
  )
  await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('')
  await expect(page).toHaveURL(/\/entrar\?/)
  await expect(page.locator('body')).not.toContainText(
    'private synthetic detail',
  )
  expect(requests).toBe(1)
})

test('pending login disables duplicate submissions and shows unavailable safely', async ({
  page,
}) => {
  let respond: () => void = () => {}
  const responseGate = new Promise<void>((resolve) => {
    respond = resolve
  })
  let requests = 0
  await page.route('**/api/auth/login', async (route) => {
    requests++
    await responseGate
    await route.fulfill({
      status: 503,
      json: { message: 'private synthetic detail' },
    })
  })
  await page.goto('/entrar')
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })
  await page.getByLabel('Usuário', { exact: true }).fill('fixture_user')
  await page.getByLabel('Senha', { exact: true }).fill('synthetic-password')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  try {
    await expect(page.getByRole('button', { name: 'Entrando…' })).toBeDisabled()
    await expect(page.getByLabel('Senha', { exact: true })).toBeDisabled()
    await expect.poll(() => requests).toBe(1)
    await page.locator('form').dispatchEvent('submit')
    expect(requests).toBe(1)
  } finally {
    respond()
  }
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível entrar agora',
  )
  await expect(
    page.getByRole('button', { name: 'Entrar', exact: true }),
  ).toBeEnabled()
  expect(requests).toBe(1)
})

test('logout requires an explicit action and does not claim success on failure', async ({
  page,
}) => {
  let requests = 0
  await page.route('**/api/auth/logout', async (route) => {
    requests++
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({})
    await route.fulfill({ status: 503, json: {} })
  })
  await page.goto('/sair')
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })
  await expect(
    page.getByRole('heading', { name: 'Sair da conta' }),
  ).toBeVisible()
  expect(requests).toBe(0)
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Sua sessão pode continuar ativa',
  )
  await expect(page).toHaveURL(/\/sair$/)
  expect(requests).toBe(1)
})
