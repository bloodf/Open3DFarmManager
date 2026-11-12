import { test, expect, type Page } from '@playwright/test'

const token = 'T'.repeat(43)
async function hydrated(page: Page) {
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })
}

test('first-access form posts the setup code header, then clears secrets', async ({
  page,
}) => {
  let seen: { header: string | undefined; body: unknown } | undefined
  await page.route('**/api/auth/bootstrap', async (route) => {
    seen = {
      header: route.request().headers()['x-bootstrap-token'],
      body: route.request().postDataJSON(),
    }
    await route.fulfill({ status: 400, json: { message: 'private detail' } })
  })
  await page.goto('/primeiro-acesso')
  await hydrated(page)
  await page.getByLabel('Código de configuração').fill('setup-code')
  await page.getByLabel('Usuário', { exact: true }).fill('dono_farm')
  await page.getByLabel('Senha', { exact: true }).fill('senha-sintetica-longa')
  await page
    .getByRole('button', { name: 'Criar conta de proprietário' })
    .click()
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível criar a conta',
  )
  expect(seen).toEqual({
    header: 'setup-code',
    body: { username: 'dono_farm', password: 'senha-sintetica-longa' },
  })
  await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('')
  // The code stays so a retry (for example a taken username) needs no re-paste.
  await expect(page.getByLabel('Código de configuração')).toHaveValue(
    'setup-code',
  )
  await expect(page.getByLabel('Código de configuração')).toHaveAttribute(
    'type',
    'password',
  )
  await expect(page.locator('body')).not.toContainText('private detail')
})

test('invite link fills the code from the fragment and removes it from the URL', async ({
  page,
}) => {
  let header: string | undefined
  await page.route('**/api/auth/register', async (route) => {
    header = route.request().headers()['x-invite-token']
    await route.fulfill({ status: 200, json: { accountId: 'a' } })
  })
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, json: {} }),
  )
  await page.goto('/criar-conta#codigo=' + token)
  await hydrated(page)
  await expect(page).toHaveURL(/\/criar-conta$/)
  await expect(page.getByLabel('Código do convite')).toHaveValue(token)
  await page.getByLabel('Usuário', { exact: true }).fill('nova_pessoa')
  await page.getByLabel('Senha', { exact: true }).fill('senha-sintetica-longa')
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  expect(header).toBe(token)
})

test('pending registration disables duplicate submit and reports rate limit', async ({
  page,
}) => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  let requests = 0
  await page.route('**/api/auth/register', async (route) => {
    requests++
    await gate
    await route.fulfill({ status: 429, json: {} })
  })
  await page.goto('/criar-conta')
  await hydrated(page)
  await page.getByLabel('Código do convite').fill(token)
  await page.getByLabel('Usuário', { exact: true }).fill('nova_pessoa')
  await page.getByLabel('Senha', { exact: true }).fill('senha-sintetica-longa')
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click()
  try {
    await expect(
      page.getByRole('button', { name: 'Criando conta…' }),
    ).toBeDisabled()
    await page.locator('form').dispatchEvent('submit')
    expect(requests).toBe(1)
  } finally {
    release()
  }
  await expect(page.getByRole('alert')).toContainText('Muitas tentativas')
})

test('owner invite page shows the link once and maps forbidden to a clear message', async ({
  page,
}) => {
  const farmId = '11111111-1111-4111-8111-111111111111'
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({ json: { farms: [{ farmId }], nextAfter: null } }),
  )
  let calls = 0
  await page.route(`**/api/farms/${farmId}/invites`, async (route) => {
    calls++
    expect(route.request().postDataJSON()).toEqual({ role: 'operator' })
    if (calls === 1)
      return route.fulfill({
        json: { token, role: 'operator', expiresAt: '2030-01-01T00:00:00Z' },
      })
    return route.fulfill({ status: 403, json: {} })
  })
  await page.goto('/convites')
  await hydrated(page)
  await page.getByLabel('Papel').selectOption('operator')
  await page.getByRole('button', { name: 'Criar convite' }).click()
  await expect(page.getByLabel('Link do convite')).toHaveValue(
    new RegExp(`/criar-conta#codigo=${token}$`),
  )
  await page.getByRole('button', { name: 'Criar convite' }).click()
  await expect(page.getByRole('alert')).toContainText('Somente proprietários')
  await expect(page.getByLabel('Link do convite')).toHaveCount(0)
})
