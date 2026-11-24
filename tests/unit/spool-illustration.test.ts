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
      server: { host: '127.0.0.1', port: 0, fs: { allow: ['.'] } },
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
    'renders colors, zero and unknown in %s mode',
    async (scheme) => {
      await withBrowser({}, async (browser) => {
        const page = await browser.newPage({
          colorScheme: scheme,
          viewport: { width: 375, height: 500 },
        })
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(origin)
        expect(
          await page
            .locator('main')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        ).toBe(scheme === 'light' ? 'rgb(244, 245, 243)' : 'rgb(24, 28, 25)')
        const spools = page.locator('.spool-illustration')
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
        const paints = await page
          .locator('.spool-wind')
          .evaluateAll((elements) =>
            elements.map(
              (element) => getComputedStyle(element).backgroundColor,
            ),
          )
        expect(paints[0]).not.toBe(paints[1])
        expect(
          await page
            .locator('.spool-illustration img')
            .evaluateAll((images) =>
              images.every(
                (image) =>
                  image instanceof HTMLImageElement &&
                  image.complete &&
                  image.naturalWidth > 0,
              ),
            ),
        ).toBe(true)
        expect(errors).toEqual([])
        await page.close()
      })
    },
  )
})
