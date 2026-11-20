import { expect, test } from '@playwright/test'
import { contaPageBundle, sairPageBundle } from './mount-account-security.ts'

async function mountConta(page: import('@playwright/test').Page) {
  await page.goto('/healthz')
  await page.evaluate(() => {
    document.body.innerHTML = '<div id="fixture"></div>'
    ;(window as any).__passwordChangeMode = 'success'
    ;(window as any).__accountSecurityFetchCalls = []
  })
  await page.addScriptTag({ content: await contaPageBundle() })
  await page.evaluate(() =>
    (window as any).mountContaPage(document.querySelector('#fixture')),
  )
}

async function mountSair(page: import('@playwright/test').Page) {
  await page.goto('/healthz')
  await page.evaluate(() => {
    document.body.innerHTML = '<div id="fixture"></div>'
    ;(window as any).__accountSecurityFetchCalls = []
    ;(window as any).__navigateToTarget = null
  })
  await page.addScriptTag({ content: await sairPageBundle() })
  await page.evaluate(() =>
    (window as any).mountSairPage(document.querySelector('#fixture')),
  )
}

test('account password change succeeds and posts current and new password', async ({
  page,
}) => {
  await mountConta(page)
  await expect(
    page.getByRole('heading', { name: 'Conta', exact: true }),
  ).toBeVisible()
  await page.getByLabel('Senha atual').fill('senha-atual-fixture')
  await page.getByLabel('Nova senha').fill('nova-senha-fixture-12')
  await page.getByRole('button', { name: 'Alterar senha' }).click()
  await expect(
    page.getByRole('status').filter({
      hasText: 'Senha alterada. As outras sessões foram encerradas.',
    }),
  ).toBeVisible()

  const passwordCalls = await page.evaluate(() =>
    (window as any).__accountSecurityFetchCalls.filter(
      (call: { url: string }) => call.url.endsWith('/api/auth/password'),
    ),
  )
  expect(passwordCalls).toEqual([
    {
      url: '/api/auth/password',
      method: 'POST',
      body: {
        currentPassword: 'senha-atual-fixture',
        newPassword: 'nova-senha-fixture-12',
      },
    },
  ])
  await expect(page.getByLabel('Senha atual')).toHaveValue('')
  await expect(page.getByLabel('Nova senha')).toHaveValue('')
})

test('account password change reports wrong current password', async ({
  page,
}) => {
  await mountConta(page)
  await page.evaluate(() => {
    ;(window as any).__passwordChangeMode = 'wrong-current'
  })
  await page.getByLabel('Senha atual').fill('senha-errada')
  await page.getByLabel('Nova senha').fill('nova-senha-fixture-12')
  await page.getByRole('button', { name: 'Alterar senha' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível alterar a senha. Confira a senha atual e tente novamente.',
  )

  const passwordCalls = await page.evaluate(() =>
    (window as any).__accountSecurityFetchCalls.filter(
      (call: { url: string }) => call.url.endsWith('/api/auth/password'),
    ),
  )
  expect(passwordCalls).toHaveLength(1)
})

test('sign out everywhere revokes all sessions and navigates home', async ({
  page,
}) => {
  await mountSair(page)
  await expect(
    page.getByRole('heading', { name: 'Sair da conta' }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Sair de todos os dispositivos' })
    .click()

  const revokeCalls = await page.evaluate(() =>
    (window as any).__accountSecurityFetchCalls.filter(
      (call: { url: string }) => call.url.endsWith('/api/auth/sessions/revoke'),
    ),
  )
  expect(revokeCalls).toEqual([
    { url: '/api/auth/sessions/revoke', method: 'POST', body: {} },
  ])
  const logoutCalls = await page.evaluate(() =>
    (window as any).__accountSecurityFetchCalls.filter(
      (call: { url: string }) => call.url.endsWith('/api/auth/logout'),
    ),
  )
  expect(logoutCalls).toEqual([])

  const target = await page.evaluate(() => (window as any).__navigateToTarget)
  expect(target).toBe('/')
})
