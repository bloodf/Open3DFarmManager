import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBrowser } from '../helpers/browser'

describe('spool illustration surfaces', () => {
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
        const ace = page.getByRole('region', { name: 'Slots ACE' })
        expect(
          await ace
            .getByRole('img', { name: 'Filamento restante: desconhecido' })
            .getAttribute('data-unknown'),
        ).toBe('true')
        expect(
          await ace
            .locator('.farm-spool[data-unknown="true"]')
            .getAttribute('data-level'),
        ).toBe('1')
        const wallSlots = page.getByRole('list', { name: 'Slots de filamento' })
        for (const [percent, frame] of [
          ['25', '6'],
          ['0', '8'],
        ]) {
          const meter = page
            .getByRole('meter', { name: 'Filamento restante' })
            .and(page.locator(`[aria-valuenow="${percent}"]`))
          const slot = wallSlots.getByRole('listitem').filter({ has: meter })
          expect(
            await slot.getByRole('meter').getAttribute('aria-valuenow'),
          ).toBe(percent)
          expect(
            await slot.locator('.farm-spool').getAttribute('data-level'),
          ).toBe(frame)
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
        expect(errors).toEqual([])
        await page.close()
      })
    },
  )
})
