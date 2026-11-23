import { defineConfig } from '@playwright/test'
import { browserOptions } from './tests/helpers/browser.ts'

const origin = process.env.BROWSER_DEVICE_HTTP_TEST_ORIGIN
if (origin) {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error(
      'BROWSER_DEVICE_HTTP_TEST_ORIGIN must be an HTTPS loopback origin',
    )
  }
  if (
    parsed.protocol !== 'https:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      'BROWSER_DEVICE_HTTP_TEST_ORIGIN must be an HTTPS loopback origin',
    )
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'browser-device-http-real.spec.ts',
  workers: 1,
  timeout: 180_000,
  globalTimeout: 240_000,
  retries: 0,
  outputDir:
    process.env.BROWSER_DEVICE_HTTP_TEST_OUTPUT_DIR ??
    'test-results/browser-device-http',
  // The fixture issues a disposable loopback certificate. No production TLS override.
  use: {
    baseURL: origin,
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    ...browserOptions(),
  },
})
