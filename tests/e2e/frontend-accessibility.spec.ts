import { expect, test } from '@playwright/test'

test('home keyboard navigation exposes account routes and unavailable read-only state', async ({
  page,
}) => {
  await page.goto('/')
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('link', { name: 'Entrar', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('link', { name: 'Sair da conta', exact: true }),
  ).toBeFocused()

  await expect(
    page.getByRole('heading', { name: 'Recursos ainda indisponíveis' }),
  ).toBeVisible()
  await expect(page.getByRole('main')).toContainText(
    'O pareamento de um Connector depende de uma etapa futura que ainda não está disponível.',
  )
  await expect(page.getByRole('main')).toContainText(
    'Sem conexão, o modo degradado será somente leitura; comandos não estarão disponíveis.',
  )
  await expect(page.getByRole('button')).toHaveCount(0)
})

test('login is keyboard operable, labels help, and failed submission focuses an associated error', async ({
  page,
}) => {
  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({
      status: 401,
      json: { message: 'private synthetic detail' },
    })
  })
  await page.goto('/entrar')

  const username = page.getByRole('textbox', { name: 'Usuário' })
  const password = page.getByLabel('Senha', { exact: true })
  const error = page.getByRole('alert')
  await expect(username).toHaveAttribute('aria-describedby', 'username-help')
  await expect(page.locator('#username-help')).toContainText(
    'letras minúsculas',
  )

  await page.keyboard.press('Tab')
  await expect(username).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(password).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('button', { name: 'Entrar', exact: true }),
  ).toBeFocused()

  await username.fill('fixture_user')
  await password.fill('synthetic-password')
  await page.keyboard.press('Enter')
  await expect(error).toContainText('Usuário ou senha inválidos')
  await expect(error).toBeFocused()
  await expect(password).toHaveValue('')
  await expect(page.locator('body')).not.toContainText(
    'private synthetic detail',
  )
})

test('logout failure focuses an announced error and success returns home', async ({
  page,
}) => {
  let outcome: 'failure' | 'success' = 'failure'
  let requests = 0
  await page.route('**/api/auth/logout', async (route) => {
    requests++
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({})
    if (outcome === 'failure') {
      await route.fulfill({
        status: 503,
        json: { message: 'private synthetic detail' },
      })
      return
    }
    await route.fulfill({ status: 204, body: '' })
  })
  await page.goto('/sair')

  const submit = page.getByRole('button', {
    name: 'Sair da conta',
    exact: true,
  })
  await expect(submit).toBeVisible()
  expect(requests).toBe(0)
  await page.keyboard.press('Tab')
  await expect(submit).toBeFocused()
  await page.keyboard.press('Enter')
  const error = page.getByRole('alert')
  await expect(error).toContainText('Sua sessão pode continuar ativa')
  await expect(error).toBeFocused()
  await expect(page.locator('body')).not.toContainText(
    'private synthetic detail',
  )
  await expect(page).toHaveURL(/\/sair$/)

  outcome = 'success'
  await submit.click()
  await expect(page).toHaveURL('/')
  expect(requests).toBe(2)
})

test('pending logout disables duplicate submits until the request settles', async ({
  page,
}) => {
  let respond: () => void = () => {}
  const responseGate = new Promise<void>((resolve) => {
    respond = resolve
  })
  let requests = 0
  await page.route('**/api/auth/logout', async (route) => {
    requests++
    await responseGate
    await route.fulfill({ status: 503, json: {} })
  })
  await page.goto('/sair')
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click()
  try {
    const pendingButton = page.getByRole('button', { name: 'Saindo…' })
    await expect(pendingButton).toBeDisabled()
    await expect(page.getByRole('status')).toContainText(
      'Encerrando sua sessão.',
    )
    await expect.poll(() => requests).toBe(1)
    await page.locator('form').dispatchEvent('submit')
    expect(requests).toBe(1)
  } finally {
    respond()
  }
  await expect(page.getByRole('alert')).toContainText(
    'Sua sessão pode continuar ativa',
  )
})
