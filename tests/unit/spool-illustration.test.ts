import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrowser } from '../helpers/browser'

describe('spool illustration', () => {
  let server: ViteDevServer
  let cacheDir: string
  let origin: string

  beforeAll(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'openfarm-spool-test-'))
    server = await createServer({
      root: 'tests/spool-illustration',
      cacheDir,
      plugins: [vue()],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [process.cwd()] } },
      logLevel: 'error',
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('No test port')
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await server?.close()
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
  })

  it.each(['light', 'dark'] as const)(
    'renders stock, printer slots and job matches in %s mode',
    async (scheme) => {
      await withBrowser({}, async (browser) => {
        const page = await browser.newPage({
          colorScheme: scheme,
          viewport: { width: 375, height: 500 },
        })
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.route('**/*', (route) =>
          route
            .request()
            .url()
            .startsWith(origin + '/')
            ? route.continue()
            : route.abort(),
        )
        await page.goto(origin)
        expect(
          await page
            .locator('main')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        ).toBe(scheme === 'light' ? 'rgb(244, 245, 243)' : 'rgb(24, 28, 25)')
        const spools = page
          .getByRole('region', { name: 'Níveis da bobina' })
          .getByRole('img')
        await spools.first().waitFor()
        expect(
          await spools.evaluateAll((elements) =>
            elements.map((element) => [
              element.dataset.level,
              element.dataset.unknown ?? null,
            ]),
          ),
        ).toEqual([
          ['3', null],
          ['3', null],
          ['8', null],
          ['1', 'true'],
        ])
        expect(await spools.nth(2).locator('.spool-wind').count()).toBe(0)
        expect(
          await spools.nth(3).locator('.spool-unknown').textContent(),
        ).toBe('?')
        expect(await spools.nth(3).getAttribute('aria-label')).toBe(
          'Nível restante desconhecido',
        )
        expect(await spools.nth(3).locator('.spool-wind').count()).toBe(1)
        const inventory = page.getByRole('region', {
          name: 'Estoque de filamento',
        })
        const oldSpool = inventory.getByRole('row', { name: /Bobina antiga/ })
        expect(await oldSpool.getByRole('img').getAttribute('data-level')).toBe(
          '1',
        )
        expect(
          await oldSpool.getByRole('img').getAttribute('data-unknown'),
        ).toBe('true')
        expect(
          await inventory
            .getByRole('row', { name: /PLA com peso inicial/ })
            .getByRole('img', { name: 'Nível restante: 25%' })
            .getAttribute('data-level'),
        ).toBe('6')
        const aceSlots = page.getByRole('region', { name: 'Slots ACE' })
        expect(
          await aceSlots
            .getByRole('img', { name: 'Filamento restante: desconhecido' })
            .getAttribute('data-unknown'),
        ).toBe('true')
        expect(
          await aceSlots.locator('.farm-spool').getAttribute('data-level'),
        ).toBe('1')
        const wallSlots = page.getByRole('list', { name: 'Slots de filamento' })
        for (const [material, percent, level] of [
          ['PLA', '25', '6'],
          ['PETG', '0', '8'],
        ]) {
          const slot = wallSlots
            .getByRole('listitem')
            .filter({ hasText: material })
          expect(
            await slot
              .getByRole('meter', { name: 'Filamento restante' })
              .getAttribute('aria-valuenow'),
          ).toBe(percent)
          expect(
            await slot.locator('.farm-spool').getAttribute('data-level'),
          ).toBe(level)
        }
        await page.getByRole('button', { name: 'Tabela', exact: true }).click()
        expect(
          await page
            .getByRole('table', { name: 'Impressoras atribuídas' })
            .getByRole('img', { name: 'Nível restante: 70%' })
            .getAttribute('data-level'),
        ).toBe('3')
        await page.getByRole('button', { name: 'Abrir mapeamento' }).click()
        const match = page.getByRole('region', { name: 'Mapeamento do AMS' })
        const slot = match.getByLabel('Filamento 1: PLA')
        await slot.waitFor()
        expect(await slot.inputValue()).toBe('0')
        // The reels are decorative (FilamentMatch/FarmSpool); the slot's amount is
        // announced by its level meter, so assert both the drawing and the name.
        const slotReel = match.locator('[data-side="slot"] [data-level]')
        expect(await slotReel.getAttribute('data-level')).toBe('6')
        expect(
          await match
            .getByRole('meter', { name: 'Quantidade restante no Slot ams:0:0' })
            .getAttribute('aria-valuenow'),
        ).toBe('25')
        await slot.selectOption('2')
        expect(await slotReel.getAttribute('data-unknown')).toBe('true')
        expect(
          await match
            .getByRole('img', {
              name: 'Quantidade restante no Slot 0:0: desconhecido',
            })
            .getAttribute('data-unknown'),
        ).toBe('true')
        await page.keyboard.press('Escape')
        const paints = await page
          .locator('.spool-wind')
          .evaluateAll((elements) =>
            elements.map(
              (element) => getComputedStyle(element).backgroundColor,
            ),
          )
        expect(paints[0]).not.toBe(paints[1])
        expect(
          await spools.evaluateAll(async (reels) => {
            const urls = reels.flatMap((reel) => [
              getComputedStyle(reel, '::before').backgroundImage,
              ...[...reel.querySelectorAll('.spool-wind')].map(
                (winding) => getComputedStyle(winding).maskImage,
              ),
            ])
            const sizes = await Promise.all(
              urls.map(async (url) => {
                const source = /^url\("(.*)"\)$/.exec(url)?.[1]
                if (!source) return 0
                const image = new Image()
                image.src = source
                await image.decode()
                return image.naturalWidth
              }),
            )
            return sizes.every((size) => size > 0)
          }),
        ).toBe(true)
        expect(errors).toEqual([])
        await page.close()
      })
    },
  )
})
