import { defineConfig } from '@playwright/test'

// Opt-in journey harness. Not part of check:all; run with `pnpm run test:journey`.
// The harness starts its own database, farm app, Connector and simulator.
export default defineConfig({
  testDir: './tests/journey',
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 5 * 60_000,
  outputDir: process.env.OPENFARM_JOURNEY_OUTPUT ?? 'test-results/journey',
  use: { browserName: 'chromium', ignoreHTTPSErrors: true },
})
