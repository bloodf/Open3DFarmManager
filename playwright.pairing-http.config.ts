import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch:
    process.env.PAIRING_HTTP_TEST_PHASE === 'remaining'
      ? 'pairing-http-remaining.spec.ts'
      : 'pairing-http.spec.ts',
  workers: 1,
  outputDir: process.env.PAIRING_HTTP_TEST_OUTPUT_DIR ?? 'test-results',
  use: { browserName: 'chromium', ignoreHTTPSErrors: true },
})
