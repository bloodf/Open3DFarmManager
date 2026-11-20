import { execFileSync } from 'node:child_process'
import { defineConfig } from '@playwright/test'
import { browserOptions } from './tests/helpers/browser.ts'
import { e2ePort } from './tests/helpers/e2e-port.ts'

// Pick free loopback ports once and pass them to Playwright workers as well.
const freePortScript = `const net = require('node:net')
const a = net.createServer()
const b = net.createServer()
a.listen(0, '127.0.0.1', () => b.listen(0, '127.0.0.1', () => {
  console.log(a.address().port + ' ' + b.address().port)
  a.close()
  b.close()
}))`
if (!process.env.E2E_PORT || !process.env.E2E_LEGACY_FLAG_PORT) {
  const [first, second] = execFileSync(
    process.execPath,
    ['-e', freePortScript],
    {
      encoding: 'utf8',
    },
  )
    .trim()
    .split(' ')
  process.env.E2E_PORT ||= first
  process.env.E2E_LEGACY_FLAG_PORT ||= second
}
const port = e2ePort('E2E_PORT', 3100)
// Slow or emulated desktops: scale every Playwright timeout, never the assertions.
const timeoutScale = Math.max(
  1,
  Number(process.env.OPENFARM_TIMEOUT_SCALE) || 1,
)
// Same build started with the removed farm view flag set to hide the route;
// tests/e2e/skeleton.spec.ts checks the stale setting no longer hides /farm.
const legacyFlagPort = e2ePort('E2E_LEGACY_FLAG_PORT', 3102)

const server = (serverPort: string, env: Record<string, string> = {}) => ({
  command: 'node tests/e2e/e2e-web-server.mjs',
  url: `http://127.0.0.1:${serverPort}/healthz`,
  env: { NITRO_HOST: '127.0.0.1', NITRO_PORT: serverPort, ...env },
  reuseExistingServer: false,
})

export default defineConfig({
  testDir: './tests/e2e',
  // Opt-in journeys on the E16 harness: playwright.farm-manager.config.ts.
  testIgnore: '**/farm-manager/**',
  timeout: 30_000 * timeoutScale,
  expect: { timeout: 5_000 * timeoutScale },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...browserOptions(),
  },
  webServer: [
    server(port),
    server(legacyFlagPort, { NUXT_PUBLIC_FLAGS_FARM_VIEW: 'false' }),
  ],
})
