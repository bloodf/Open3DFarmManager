import { expect, test, type Page } from '@playwright/test'

// The shell's first tab stop is its skip link; following it by keyboard moves
// focus to the page content, as a keyboard-only user would.
async function skipToContent(page: Page) {
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('link', { name: 'Pular para o conteúdo' }),
  ).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#conteudo-shell')).toBeFocused()
}

test('home keyboard navigation exposes account routes and unavailable read-only state', async ({
  page,
}) => {
  await page.goto('/')
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })
  const main = page.getByRole('main')
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Sua farm de impressão, em um só lugar.',
    }),
  ).toBeFocused()
  const quick = main.getByRole('navigation', { name: 'Acessos rápidos' })
  for (const name of [
    'Minha farm',
    'Consultar Connectors',
    'Aprovar Connector',
    'Dispositivos do navegador',
    'Entrar',
    // Static quick link; the settings page itself refuses non-admins.
    'Contas · Provedores de entrada',
    'Convidar pessoa',
    'Sair da conta',
  ]) {
    await page.keyboard.press('Tab')
    await expect(quick.getByRole('link', { name, exact: true })).toBeFocused()
  }

  await expect(
    page.getByRole('heading', { name: 'Recursos ainda indisponíveis' }),
  ).toBeVisible()
  await expect(page.getByRole('main')).toContainText(
    'O pareamento de um Connector depende da configuração segura do serviço e da aprovação de um proprietário ou administrador da farm.',
  )
  await expect(page.getByRole('main')).toContainText(
    'Sem conexão, o modo degradado será somente leitura; comandos não estarão disponíveis.',
  )
  // The page content offers no commands; the shell's own controls are not part of it.
  await expect(main.getByRole('button')).toHaveCount(0)
})

test('login is keyboard operable, labels help, and failed submission focuses an announced error', async ({
  page,
}) => {
  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({
      status: 401,
      json: { message: 'private synthetic detail' },
    })
  })
  await page.goto('/entrar')
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })

  const username = page.getByRole('textbox', { name: 'Usuário' })
  const password = page.getByLabel('Senha', { exact: true })
  const error = page.getByRole('alert')
  await expect(username).toHaveAttribute('aria-describedby', 'username-help')
  await expect(page.locator('#username-help')).toContainText(
    'letras minúsculas',
  )

  await skipToContent(page)
  await page.keyboard.press('Tab')
  await expect(
    page
      .getByRole('navigation', { name: 'Localização' })
      .getByRole('link', { name: 'Início' }),
  ).toBeFocused()
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

test('successful login by keyboard returns home and focuses its heading', async ({
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
    await route.fulfill({ status: 204, body: '' })
  })
  await page.goto('/entrar')
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })
  await skipToContent(page)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('textbox', { name: 'Usuário' })).toBeFocused()
  await page.keyboard.type('fixture_user')
  await page.keyboard.press('Tab')
  await page.keyboard.type('synthetic-password')
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('button', { name: 'Entrar', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL('/')
  await expect(
    page.getByRole('heading', {
      name: 'Sua farm de impressão, em um só lugar.',
    }),
  ).toBeFocused()
  expect(requests).toBe(1)
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
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })

  const submit = page.getByRole('button', {
    name: 'Sair da conta',
    exact: true,
  })
  await expect(submit).toBeVisible()
  expect(requests).toBe(0)
  await skipToContent(page)
  await page.keyboard.press('Tab')
  await expect(submit).toBeFocused()
  await page.keyboard.press('Enter')
  const error = page.getByRole('alert')
  await expect(error).toContainText('Sua sessão pode continuar ativa')
  await expect(error).toBeFocused()
  await expect(page.locator('body')).not.toContainText(
    'private synthetic detail',
  )
  // Still on the logout page; the skip link only adds its in-page fragment.
  await expect(page).toHaveURL(/\/sair(#conteudo-shell)?$/)

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
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click()
  try {
    const pendingButton = page.getByRole('button', { name: 'Saindo…' })
    await expect(pendingButton).toBeDisabled()
    await expect(page.locator('form').getByRole('status')).toContainText(
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
