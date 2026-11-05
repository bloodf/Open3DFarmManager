export default defineNuxtConfig({
  compatibilityDate: '2026-11-04',
  devtools: { enabled: false },
  nitro: { preset: 'node-server' },
  app: { head: { htmlAttrs: { lang: 'pt-BR' }, title: 'Open3DFarmManager' } },
  runtimeConfig: {
    auth: { enabled: false, origin: '', sessionSecret: '', databaseUrl: '' },
    public: { flags: { farmView: false } },
  },
  typescript: { strict: true },
  css: ['~/assets/main.css'],
})
