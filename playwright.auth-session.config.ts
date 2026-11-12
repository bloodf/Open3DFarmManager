import { randomBytes } from 'node:crypto'
import { defineConfig } from '@playwright/test'

const env = process.env
const app = Number(env.AUTH_E2E_APP_PORT)
const tls = Number(env.AUTH_E2E_TLS_PORT)
const db = Number(env.AUTH_E2E_DB_PORT)
if (![app, tls, db].every(Number.isInteger))
  throw new Error(
    'AUTH_E2E_APP_PORT, AUTH_E2E_TLS_PORT and AUTH_E2E_DB_PORT (disposable PostgreSQL) required',
  )
const origin = `https://127.0.0.1:${tls}`
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'auth-lockout-session.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 90_000,
  use: {
    baseURL: origin,
    browserName: 'chromium',
    // Disposable loopback certificate only.
    ignoreHTTPSErrors: true,
  },
  webServer: [
    {
      command: 'node apps/farm/.output/server/index.mjs',
      url: `http://127.0.0.1:${app}/healthz`,
      env: {
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: String(app),
        NUXT_AUTH_ENABLED: 'true',
        NUXT_AUTH_ORIGIN: origin,
        NUXT_AUTH_SESSION_SECRET: randomBytes(48).toString('base64url'),
        NUXT_AUTH_DATABASE_URL: `postgres://o3dfm_w05_auth@127.0.0.1:${db}/fixture`,
      },
      reuseExistingServer: false,
    },
    {
      command: 'node tests/helpers/auth-tls-proxy.ts',
      url: origin,
      ignoreHTTPSErrors: true,
      env: { AUTH_E2E_APP_PORT: String(app), AUTH_E2E_TLS_PORT: String(tls) },
      reuseExistingServer: false,
    },
  ],
})
