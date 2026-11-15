import { test, expect, type Page } from '@playwright/test'

/** Holds every client script until released, so the SSR form is live but unhydrated. */
async function holdScripts(page: Page) {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/_nuxt/**/*.js', async (route) => {
    await released
    await route.continue()
  })
  return release
}
const hydrated = (page: Page) =>
  page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })

for (const form of [
  {
    path: '/entrar',
    button: 'Entrar',
    fields: { Usuário: 'fixture_user', Senha: 'synthetic-password' },
  },
  {
    path: '/criar-conta',
    button: 'Criar conta',
    fields: { Usuário: 'fixture_user', Senha: 'synthetic-password-long' },
  },
  {
    path: '/primeiro-acesso',
    button: undefined,
    fields: { Usuário: 'fixture_user', Senha: 'synthetic-password-long' },
  },
  {
    path: '/redefinir-senha',
    button: 'Redefinir senha',
    fields: { Usuário: 'fixture_user' },
  },
]) {
  test(`${form.path} cannot be submitted natively before hydration`, async ({
    page,
  }) => {
    const posts: string[] = []
    page.on('request', (request) => {
      if (request.method() !== 'GET') posts.push(request.url())
    })
    const release = await holdScripts(page)
    await page.goto(form.path, { waitUntil: 'domcontentloaded' })
    for (const [label, value] of Object.entries(form.fields))
      await page.getByLabel(label, { exact: true }).fill(value)
    const submit = form.button
      ? page.getByRole('button', { name: form.button, exact: true })
      : page.locator('form button[type="submit"]')
    await expect(submit).toBeDisabled()
    await expect(
      page.getByRole('status').filter({ hasText: 'Preparando o formulário' }),
    ).toBeVisible()
    // Implicit submission (Enter) must not submit either.
    await page.getByLabel('Usuário', { exact: true }).press('Enter')
    await page.waitForTimeout(500)
    expect(new URL(page.url()).pathname).toBe(form.path)
    expect(page.url()).not.toContain('synthetic')
    expect(posts).toEqual([])
    release()
    await hydrated(page)
    await expect(submit).toBeEnabled()
  })
}
