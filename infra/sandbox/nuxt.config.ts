import { fileURLToPath } from 'node:url'

const farm = fileURLToPath(new URL('../../apps/farm', import.meta.url))

// This separate build opts the local sandbox into the bounded signalling adapter.
export default defineNuxtConfig({
  extends: farm,
  srcDir: `${farm}/app`,
  vite: {
    $client: {
      tsconfig: fileURLToPath(
        new URL('./.nuxt/tsconfig.app.json', import.meta.url),
      ),
    },
    $server: {
      tsconfig: fileURLToPath(
        new URL('./.nuxt/tsconfig.server.json', import.meta.url),
      ),
    },
  },
  runtimeConfig: { connectorSignalling: { enabled: true } },
  nitro: {
    preset: 'node-server',
    ...(process.env.SANDBOX_OUTPUT_DIR
      ? { output: { dir: process.env.SANDBOX_OUTPUT_DIR } }
      : {}),
  },
})
