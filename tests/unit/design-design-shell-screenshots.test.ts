import { mkdir, readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import AxeBuilder from '@axe-core/playwright'
import { launchBrowser } from '../helpers/browser.ts'

it('captures shell screens when requested', async () => {
  if (process.env.DESIGN_SCREENSHOTS !== '1') {
    const layout = await readFile('apps/farm/app/layouts/default.vue', 'utf8')
    expect(layout).toContain('aria-keyshortcuts="Control+K Meta+K /"')
    expect(layout).toContain('href="#conteudo-shell"')
    return
  }
  const base = process.env.DESIGN_BASE_URL
  expect(base).toBeTruthy()
  const phase = process.env.DESIGN_PHASE === 'after' ? 'after' : 'before'
  await mkdir('docs/fullfarmmanager/design', { recursive: true })
  const browser = await launchBrowser()
  try {
    for (const [screen, path] of [
      ['farm', '/farm'],
      ['painel', '/painel'],
    ]) {
      for (const [size, viewport] of [
        ['desktop', { width: 1440, height: 900 }],
        ['mobile', { width: 390, height: 844 }],
      ] as const) {
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({
            viewport,
            locale: 'pt-BR',
            reducedMotion: 'reduce',
            deviceScaleFactor: 1,
          })
          await context.addInitScript(
            (choice) => localStorage.setItem('farm-theme', choice),
            theme,
          )
          const page = await context.newPage()
          await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBe(viewport.width)
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
            [],
          )
          await page.screenshot({
            path: `docs/fullfarmmanager/design/shell-${screen}-${phase}-${size}-${theme}.png`,
          })
          await page.keyboard.press('Control+k')
          const search = page.getByRole('dialog', {
            name: 'Buscar',
            exact: true,
          })
          await search.waitFor({ state: 'visible' })
          await page.keyboard.press('Escape')
          await search.waitFor({ state: 'hidden' })
          if (size === 'mobile') {
            await page
              .getByRole('button', { name: 'Menu', exact: true })
              .click()
            const menu = page.getByRole('dialog', { name: 'Menu', exact: true })
            await menu.waitFor({ state: 'visible' })
            await page.keyboard.press('Escape')
            await menu.waitFor({ state: 'hidden' })
          }
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
  }
}, 120_000)
