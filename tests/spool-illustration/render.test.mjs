import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
const server = await createServer({
  root: 'tests/spool-illustration',
  plugins: [vue()],
  server: { host: '127.0.0.1', port: 0, fs: { allow: ['.'] } },
  logLevel: 'error',
})
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const port = server.httpServer.address().port
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({
      colorScheme: scheme,
      viewport: { width: 375, height: 500 },
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${port}`)
    await page.locator('.spool-illustration').first().waitFor()
    const levels = await page
      .locator('.spool-illustration')
      .evaluateAll((es) =>
        es.map((e) => [e.dataset.level, e.dataset.unknown ?? null]),
      )
    if (
      JSON.stringify(levels) !==
      JSON.stringify([
        ['3', null],
        ['3', null],
        ['8', null],
        ['1', 'true'],
      ])
    )
      throw new Error(JSON.stringify(levels))
    const paints = await page
      .locator('.spool-wind')
      .evaluateAll((es) => es.map((e) => getComputedStyle(e).backgroundColor))
    if (paints[0] === paints[1])
      throw new Error('Filament colors do not differ')
    if (errors.length) throw new Error(errors.join('\n'))
    console.log(scheme, JSON.stringify(levels), JSON.stringify(paints))
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
