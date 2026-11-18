import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'

test('launchBrowser uses system Chrome without bundled browsers', async () => {
  // Playwright reads the browser registry path when it is imported.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: '/nonexistent',
  }
  delete env['OPENFARM_BROWSER']
  delete env['OPENFARM_CHROME_PATH']

  const helper = new URL('../helpers/browser.ts', import.meta.url).href
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        const { launchBrowser } = await import(${JSON.stringify(helper)})
        const browser = await launchBrowser({ headless: true })
        try {
          const page = await browser.newPage()
          await page.goto('about:blank')
          const userAgent = await page.evaluate(() => navigator.userAgent)
          console.log(JSON.stringify({ version: browser.version(), userAgent }))
          await page.close()
        } finally {
          await browser.close()
        }
      `,
    ],
    { env, timeout: 25_000 },
  )

  const { version, userAgent } = JSON.parse(stdout)
  expect(version).toEqual(expect.stringMatching(/.+/))
  expect(userAgent).toMatch(/Chrome/)
})
