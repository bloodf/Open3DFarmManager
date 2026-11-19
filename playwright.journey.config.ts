import { defineConfig } from '@playwright/test'
import { browserOptions } from './tests/helpers/browser.ts'

const timeoutScale = Math.max(
  1,
  Number(process.env.OPENFARM_TIMEOUT_SCALE) || 1,
)

// Opt-in journey harness. Not part of check:all; run with `npm run test:journey`.
// The harness starts its own database, farm app, Connector and simulator.
export default defineConfig({
  testDir: './tests/journey',
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 5 * 60_000 * timeoutScale,
  expect: { timeout: 5_000 * timeoutScale },
  outputDir: process.env.OPENFARM_JOURNEY_OUTPUT ?? 'test-results/journey',
  use: {
    ignoreHTTPSErrors: true,
    ...browserOptions(),
  },
})
