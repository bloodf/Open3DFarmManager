import { defineConfig } from '@playwright/test'
// Override the loopback port with E2E_PORT when 3100 is taken.
const port = process.env.E2E_PORT ?? '3100'

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: 'node apps/farm/.output/server/index.mjs',
    url: `http://127.0.0.1:${port}/healthz`,
    env: {
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: port,
      NUXT_PUBLIC_FLAGS_FARM_VIEW: 'false',
    },
    reuseExistingServer: false,
  },
})
