import { defineConfig } from '@playwright/test'
import { browserOptions } from './tests/helpers/browser.ts'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'printer-assignment-http-real.spec.ts',
  workers: 1,
  outputDir: process.env.PRINTER_HTTP_TEST_OUTPUT_DIR ?? 'test-results',
  use: {
    ignoreHTTPSErrors: true,
    ...browserOptions(),
  },
})
