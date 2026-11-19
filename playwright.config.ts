import { execFileSync } from 'node:child_process'
import { defineConfig } from '@playwright/test'
import { browserOptions } from './tests/helpers/browser.ts'
import { e2ePort } from './tests/helpers/e2e-port.ts'

// Pick a free loopback port once and pass it to Playwright workers as well.
if (!process.env.E2E_PORT) {
  process.env.E2E_PORT = execFileSync(
    process.execPath,
    [
      '-e',
      `const server = require('node:net').createServer()
server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port)
  server.close()
})`,
    ],
    { encoding: 'utf8' },
  ).trim()
}
const port = e2ePort('E2E_PORT', 3100)
// Slow or emulated desktops: scale every Playwright timeout, never the assertions.
const timeoutScale = Math.max(
  1,
  Number(process.env.OPENFARM_TIMEOUT_SCALE) || 1,
)

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000 * timeoutScale,
  expect: { timeout: 5_000 * timeoutScale },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...browserOptions(),
  },
  webServer: {
    command: 'node apps/farm/.output/server/index.mjs',
    url: `http://127.0.0.1:${port}/healthz`,
    env: {
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: port,
      NUXT_PUBLIC_FLAGS_FARM_VIEW: 'false',
    },
    reuseExistingServer: false,
  },
})
