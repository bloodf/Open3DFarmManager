import { defineConfig } from '@playwright/test'

if (process.env.FARM_VIEW_E2E !== 'true')
  throw new Error('Set FARM_VIEW_E2E=true for the isolated farm view UI checks')

const port = process.env.FARM_VIEW_E2E_PORT ?? '3101'
if (!/^\d{4,5}$/.test(port)) throw new Error('Invalid FARM_VIEW_E2E_PORT')

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
