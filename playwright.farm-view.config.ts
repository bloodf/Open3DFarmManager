import { defineConfig } from '@playwright/test'
import { e2ePort } from './tests/helpers/e2e-port.ts'

// Override the loopback port with FARM_VIEW_PORT when 3101 is taken.
const port = e2ePort('FARM_VIEW_PORT', 3101)

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: [
    'farm-view.spec.ts',
    'farm-controls.spec.ts',
    'files-page.spec.ts',
  ],
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: 'node apps/farm/.output/server/index.mjs',
    url: `http://127.0.0.1:${port}/healthz`,
    env: {
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: port,
    },
    reuseExistingServer: false,
  },
})
