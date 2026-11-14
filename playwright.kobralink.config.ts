import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'kobralink-onboarding.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: process.env.KOBRALINK_UI_OUTPUT ?? '/tmp/kobralink-ui-results',
  use: { baseURL: 'http://127.0.0.1:3197', browserName: 'chromium' },
  webServer: {
    env: { BROWSERSLIST: 'last 1 Chrome version' },
    command: 'pnpm --dir apps/farm dev --port 3197',
    url: 'http://127.0.0.1:3197/impressoras',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
