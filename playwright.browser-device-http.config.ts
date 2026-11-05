import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'browser-device-http-real.spec.ts',
  workers: 1,
  timeout: 180_000,
  globalTimeout: 240_000,
  retries: 0,
  outputDir:
    process.env.BROWSER_DEVICE_HTTP_TEST_OUTPUT_DIR ??
    '/tmp/open3dfarm-browser-device-real-acceptance/unused-browser-output',
  // The fixture issues a disposable loopback certificate. No production TLS override.
  use: {
    baseURL: process.env.BROWSER_DEVICE_HTTP_TEST_ORIGIN,
    browserName: 'chromium',
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
})
