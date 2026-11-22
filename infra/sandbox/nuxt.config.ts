import { fileURLToPath } from 'node:url'

const farm = fileURLToPath(new URL('../../apps/farm', import.meta.url))

// This separate build opts the local sandbox into the bounded signalling adapter.
export default defineNuxtConfig({
  extends: farm,
  srcDir: `${farm}/app`,
  runtimeConfig: { connectorSignalling: { enabled: true } },
  nitro: { preset: 'node-server' },
})
