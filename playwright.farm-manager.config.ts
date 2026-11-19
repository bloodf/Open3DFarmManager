import { defineConfig } from '@playwright/test'
import { browserOptions } from './tests/helpers/browser.ts'

const timeoutScale = Math.max(
  1,
  Number(process.env.OPENFARM_TIMEOUT_SCALE) || 1,
)

// The farm-manager journeys start the E16 journey harness (tests/journey):
// a disposable database, the built farm app, a Connector and loopback mocks.
// The harness is opt-in by environment; this config opts in for its own specs.
process.env.OPENFARM_JOURNEY ??= '1'

// Run with `npx playwright test -c playwright.farm-manager.config.ts <name>`.
// Outbound network is blocked per browser context by the fixtures: every
// request outside 127.0.0.1/localhost fails the test.
export default defineConfig({
  testDir: './tests/e2e/farm-manager',
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 5 * 60_000 * timeoutScale,
  expect: { timeout: 5_000 * timeoutScale },
  outputDir: 'test-results/farm-manager',
  use: {
    ignoreHTTPSErrors: true,
    ...browserOptions(),
  },
})
