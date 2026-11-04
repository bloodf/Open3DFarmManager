import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://127.0.0.1:3100' },
  webServer: {
    command: 'node apps/farm/.output/server/index.mjs',
    url: 'http://127.0.0.1:3100/healthz',
    env: {
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: '3100',
      NUXT_PUBLIC_FLAGS_FARM_VIEW: 'false',
    },
    reuseExistingServer: false,
  },
})
