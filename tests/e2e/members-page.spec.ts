import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { membersPageBundle } from './mount-members-page.ts'

async function mount(page: import('@playwright/test').Page) {
  await page.route('**/healthz', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="fixture"></div>',
    }),
  )
  await page.goto('/healthz')
  await page.evaluate(() => {
    document.body.innerHTML = '<div id="fixture"></div>'
  })
  await page.addScriptTag({ content: await membersPageBundle() })
  await page.evaluate(() =>
    (window as any).mountMembersPage(document.querySelector('#fixture')),
  )
}

test('members page role change and removal require confirmation and post', async ({
  page,
}) => {
  await mount(page)
  await expect(
    page.getByRole('heading', { name: 'Membros e convites' }),
  ).toBeVisible()
  const adminRow = page.locator('li', {
    has: page.getByText('Admin', { exact: true }),
  })
  await expect(adminRow.getByText('Admin', { exact: true })).toBeVisible()

  await page.getByLabel('Novo papel para Admin').selectOption('viewer')
  await adminRow.getByRole('button', { name: 'Alterar papel' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Alterar papel de Admin' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Confirmar alteração de papel' }),
  ).toBeDisabled()
  await page.getByLabel('Confirmei a alteração de papel.').check()
  await page
    .getByRole('button', { name: 'Confirmar alteração de papel' })
    .click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Papel atualizado.' }),
  ).toBeVisible()

  const roleCalls = await page.evaluate(() =>
    (window as any).__membersFetchCalls.filter((call: { url: string }) =>
      call.url.includes('/role'),
    ),
  )
  expect(roleCalls).toEqual([
    {
      url: '/api/farms/11111111-1111-4111-8111-111111111111/members/admin-account/role',
      method: 'POST',
      body: { role: 'viewer' },
    },
  ])

  await page.getByRole('button', { name: 'Remover Admin' }).click()
  await expect(
    page.getByRole('heading', { name: 'Remover Admin' }),
  ).toBeVisible()
  await page.getByLabel('Confirmei a remoção deste membro.').check()
  await page.getByRole('button', { name: 'Confirmar remoção' }).click()
  await expect(
    page.getByRole('status').filter({
      hasText: 'Membro removido. As sessões dele foram encerradas.',
    }),
  ).toBeVisible()

  const removeCalls = await page.evaluate(() =>
    (window as any).__membersFetchCalls.filter((call: { url: string }) =>
      call.url.includes('/remove'),
    ),
  )
  expect(removeCalls).toEqual([
    {
      url: '/api/farms/11111111-1111-4111-8111-111111111111/members/admin-account/remove',
      method: 'POST',
      body: {},
    },
  ])
})

test('members page is keyboard operable and axe-clean', async ({ page }) => {
  await mount(page)
  await expect(page.getByLabel('Novo papel para Admin')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('link', { name: 'Criar novo convite' }),
  ).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Farm')).toBeFocused()

  const result = await new AxeBuilder({ page })
    .include('#fixture')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  expect(result.violations).toEqual([])
})
