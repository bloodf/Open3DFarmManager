import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'pairing-http.spec.ts',
  workers: 1,
  outputDir: process.env.PAIRING_HTTP_TEST_OUTPUT_DIR ?? 'test-results',
  use: { browserName: 'chromium', ignoreHTTPSErrors: true },
})
