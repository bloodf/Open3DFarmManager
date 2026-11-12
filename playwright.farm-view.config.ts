import { defineConfig } from '@playwright/test'

if (process.env.FARM_VIEW_E2E !== 'true')
  throw new Error('Set FARM_VIEW_E2E=true for the isolated farm view UI checks')

// Override the loopback port with FARM_VIEW_PORT when 3101 is taken.
const port = process.env.FARM_VIEW_PORT ?? '3101'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'farm-view.spec.ts',
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: 'node apps/farm/.output/server/index.mjs',
    url: `http://127.0.0.1:${port}/healthz`,
    env: {
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: port,
      NUXT_PUBLIC_FLAGS_FARM_VIEW: 'true',
    },
    reuseExistingServer: false,
  },
})
