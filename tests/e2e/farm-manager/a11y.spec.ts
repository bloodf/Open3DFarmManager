import AxeBuilder from '@axe-core/playwright'
import { readdirSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

const printerKey = 'moonraker-1'
const pages = readdirSync(
  new URL('../../../apps/farm/app/pages/', import.meta.url),
)
  .filter((file) => file.endsWith('.vue'))
  .map((file) => (file === 'index.vue' ? '/' : '/' + file.slice(0, -4)))

async function scan(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect
    .soft(
      violations
        .filter(({ impact }) => impact === 'serious' || impact === 'critical')
        .map(({ id, nodes }) => ({
          id,
          targets: nodes.map(({ target }) => target),
        })),
      label,
    )
    .toEqual([])
}

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible()
  for (let i = 0; i < 150; i++) {
    if (await target.evaluate((element) => element === document.activeElement))
      return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}

test('a11y: farm pages, keyboard navigation and dialog focus', async ({
  bootFarm,
}, testInfo) => {
  await test.step(
    'Complete within the configured deadline',
    async () => {
      const farm = await bootFarm({
        printers: [{ family: 'moonraker', printerKey }],
        history: true,
      })
      // One library item, so the library and replay dialogs have content.
      const uploaded = await farm.owner.evaluate(
        async ({ farmId, name }) => {
          // Server storage: Connector mode has no upload relay yet.
          const mode = await fetch(`/api/farms/${farmId}/library/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storageMode: 'server' }),
          })
          if (!mode.ok) return { status: mode.status, body: await mode.text() }
          const params = new URLSearchParams({ name, title: 'Vaso a11y' })
          const response = await fetch(
            `/api/farms/${farmId}/library?${params}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: ';FLAVOR:Marlin\nG28\nG1 X10 Y10 F3000\n',
            },
          )
          return { status: response.status, body: await response.text() }
        },
        { farmId: farm.farmId, name: 'vaso-a11y.gcode' },
      )
      expect(uploaded.status, uploaded.body).toBe(201)
      const guest = await farm.newGuestPage()
      await guest.goto(farm.origin + '/entrar')
      for (const width of [320, 768, 1280]) {
        for (const theme of ['light', 'dark'] as const) {
          await test.step(`${width}px ${theme}`, async () => {
            for (const page of [guest, farm.owner]) {
              await page.setViewportSize({ width, height: 900 })
              await page.emulateMedia({ colorScheme: theme })
              await page.evaluate(
                (value) => localStorage.setItem('farm-theme', value),
                theme,
              )
            }
            for (const path of [...pages, `/impressoras/${printerKey}`]) {
              const page = path === '/entrar' ? guest : farm.owner
              const response = await page.goto(farm.origin + path)
              expect(response?.status(), path).toBe(200)
              expect(new URL(page.url()).pathname).toBe(path)
              await expect(page.locator('main')).toBeVisible()
              await page.waitForFunction(() => {
                const root = document.querySelector('#__nuxt')
                return root && '__vue_app__' in root
              })
              if (path === '/painel') {
                await expect(page.locator('main')).toHaveCSS(
                  'color-scheme',
                  'dark',
                )
              } else {
                await expect(page.locator('html')).toHaveAttribute(
                  'data-theme',
                  theme,
                )
              }
              if (path === '/biblioteca' || path === '/farm')
                await expect(
                  page.locator('main [aria-busy="true"]'),
                ).toHaveCount(0)
              await scan(page, `${path} at ${width}px (${theme})`)
            }
          })
        }
      }

      await guest.setViewportSize({ width: 1280, height: 900 })
      await guest.emulateMedia({ reducedMotion: 'reduce' })
      await guest.goto(farm.origin + '/entrar')
      const submit = guest.getByRole('button', { name: 'Entrar', exact: true })
      await expect(submit).toBeEnabled()
      await tabTo(guest, guest.getByLabel('Usuário', { exact: true }))
      await guest.keyboard.insertText(farm.harness.accounts.owner)
      await tabTo(guest, guest.getByLabel('Senha', { exact: true }))
      await guest.keyboard.insertText(farm.harness.accounts.password)
      await tabTo(guest, submit)
      await guest.keyboard.press('Enter')
      await expect(guest).toHaveURL(farm.origin + '/')

      const nav = guest
        .getByRole('complementary')
        .getByRole('navigation', { name: 'Navegação principal' })
      const follow = async (link: Locator, path: string) => {
        await tabTo(guest, link)
        await guest.keyboard.press('Enter')
        await expect(guest).toHaveURL(farm.origin + path)
      }
      await follow(
        nav.getByRole('link', { name: 'Minha farm', exact: true }),
        '/farm',
      )
      await follow(
        guest.getByRole('link', {
          name: `Abrir detalhes da impressora ${printerKey}`,
        }),
        `/impressoras/${printerKey}`,
      )
      await follow(
        nav.getByRole('link', { name: 'Biblioteca', exact: true }),
        '/biblioteca',
      )

      // Library detail, then replay: both dialogs give focus back on close.
      const details = guest.getByRole('button', {
        name: 'Ver detalhes de Vaso a11y',
        exact: true,
      })
      await tabTo(guest, details)
      await guest.keyboard.press('Enter')
      const detail = guest.getByRole('dialog', { name: 'Vaso a11y' })
      await expect(detail).toBeVisible()
      const again = detail.getByRole('button', {
        name: 'Imprimir de novo a versão v1',
        exact: true,
      })
      await tabTo(guest, again)
      await scan(guest, 'library detail')
      await guest.keyboard.press('Enter')
      const replay = guest.getByRole('dialog', { name: 'Imprimir de novo' })
      await expect(replay).toBeVisible()
      await expect(
        replay.getByText(
          'Não há conexão direta segura com o Connector. Nenhum comando pode ser enviado.',
        ),
      ).toBeVisible()
      await expect(
        replay.getByRole('button', { name: 'Imprimir de novo', exact: true }),
      ).toBeDisabled()
      await tabTo(
        guest,
        replay.getByRole('checkbox', { name: /mesa está limpa/ }),
      )
      await scan(guest, 'replay dialog')
      await guest.keyboard.press('Escape')
      await expect(replay).toBeHidden()
      await expect(again).toBeFocused()
      await guest.keyboard.press('Escape')
      await expect(detail).toBeHidden()
      await expect(details).toBeFocused()

      await guest.setViewportSize({ width: 320, height: 900 })
      for (const [triggerName, dialogName] of [
        ['Menu', 'Menu'],
        ['Buscar páginas', 'Buscar páginas'],
        ['Atalhos', 'Atalhos de teclado'],
      ] as const) {
        const trigger = guest.getByRole('button', {
          name: triggerName,
          exact: true,
        })
        await tabTo(guest, trigger)
        await guest.keyboard.press('Enter')
        const dialog = guest.getByRole('dialog', { name: dialogName })
        await expect(dialog).toBeVisible()
        await scan(guest, dialogName)
        expect(
          await guest.evaluate(
            () =>
              matchMedia('(prefers-reduced-motion: reduce)').matches &&
              document
                .getAnimations()
                .every(({ playState }) => playState !== 'running'),
          ),
        ).toBe(true)
        await guest.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        await expect(trigger).toBeFocused()
      }
    },
    { timeout: testInfo.timeout },
  )
})
