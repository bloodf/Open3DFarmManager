import { defineConfig } from '@playwright/test'
import { browserOptions } from './tests/helpers/browser.ts'
import { e2ePort } from './tests/helpers/e2e-port.ts'

if (process.env.FARM_VIEW_E2E !== 'true')
  throw new Error('Set FARM_VIEW_E2E=true for the isolated farm view UI checks')

// Override the loopback port with SETUP_FORMS_PORT when 3113 is taken.
const port = e2ePort('SETUP_FORMS_PORT', 3113)

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'printer-setup-forms.spec.ts',
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...browserOptions(),
  },
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
