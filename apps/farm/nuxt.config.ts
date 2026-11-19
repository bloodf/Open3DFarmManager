export default defineNuxtConfig({
  compatibilityDate: '2026-11-04',
  devtools: { enabled: false },
  nitro: { preset: 'node-server' },
  app: { head: { htmlAttrs: { lang: 'pt-BR' }, title: 'Open3DFarmManager' } },
  routeRules: Object.fromEntries(
    [
      '/primeiro-acesso',
      '/criar-conta',
      '/convites',
      '/api/auth/oidc/start',
      '/api/auth/oidc/callback',
    ].map((path) => [path, { headers: { 'Referrer-Policy': 'no-referrer' } }]),
  ),
  runtimeConfig: {
    database: {
      enabled: false,
      databaseUrl: '',
      migrations: 'verify',
      migrationsDir: '',
    },
    auth: {
      enabled: false,
      origin: '',
      sessionSecret: '',
      databaseUrl: '',
      bootstrapToken: '',
      /** NUXT_AUTH_PASSWORD_RESET=true enables owner-issued reset links. */
      passwordReset: false,
      /** NUXT_AUTH_OIDC=true enables one OpenID Connect provider. Off by default. */
      oidc: false,
      oidcIssuer: '',
      oidcClientId: '',
      oidcClientSecret: '',
    },
    /** NUXT_BAMBU_CLOUD=true enables Bambu cloud import. Off and offline by default. */
    bambuCloud: false,
    integrationAuth: {
      enabled: false,
      /** Use a dedicated login in the farm_integration_apps role. */
      databaseUrl: '',
      /** NUXT_INTEGRATION_AUTH_SIGNING_KEY is 32 random bytes encoded as base64url. */
      signingKey: '',
      tokenTtlSeconds: 300,
      /** NUXT_INTEGRATION_AUTH_READ_LIMIT: per-app read requests per minute. */
      readLimit: 120,
      /** NUXT_INTEGRATION_AUTH_WRITE_LIMIT: per-app write requests per minute. */
      writeLimit: 30,
    },
    integrationJobs: {
      enabled: false,
      /** A login that is a member of farm_integration_jobs, farm_integration_approvals and farm_integration_delivery. */
      databaseUrl: '',
      /** NUXT_INTEGRATION_JOBS_ENVELOPE_SIGNING_KEY: the API issuer's Ed25519 PKCS#8 key, base64url. Empty holds jobs only. */
      envelopeSigningKey: '',
      /** The key id the Connector's trusted-key set knows the issuer by. */
      envelopeKid: '',
      /** Largest file size a job may declare, in bytes. */
      maxFileBytes: 17179869184,
      /** How long an undelivered envelope stays valid, in milliseconds. */
      envelopeTtlMs: 300000,
    },
    connectorInventory: { enabled: false, databaseUrl: '' },
    browserDevices: { enabled: false, databaseUrl: '' },
    printerAssignments: { enabled: false, databaseUrl: '' },
    /** A login that is a member of farm_spoolman_settings. */
    spoolmanSettings: { enabled: false, databaseUrl: '' },
    printerStates: { enabled: false, databaseUrl: '' },
    jobHistory: { enabled: false, databaseUrl: '' },
    telemetryPrune: {
      enabled: false,
      databaseUrl: '',
      intervalMs: 3600000,
      telemetryRetentionDays: 30,
      jobHistoryRetentionDays: 365,
      batchSize: 500,
    },
    pauseAuthority: {
      enabled: false,
      databaseUrl: '',
      issuerKeyPath: '',
      issuerPublicKeySpki: '',
      issuer: '',
      kid: '',
      audience: '',
      credentialIssuer: '',
      credentialAudience: '',
    },
    connectorTelemetry: {
      enabled: false,
      databaseUrl: '',
      origin: '',
      issuer: '',
      audience: '',
      publicKeyRegistryPath: '',
      tokenTtlSeconds: '',
      proofTtlMs: '',
      bodyTimeoutMs: '',
    },
    connectorPairing: {
      enabled: false,
      origin: '',
      databaseUrl: '',
      proofDatabaseUrl: '',
      revocationDatabaseUrl: '',
      audience: '',
      issuer: '',
      signingKeyId: '',
      signingKeyPath: '',
      tokenTtlSeconds: '',
    },
    connectorRenewal: {
      enabled: false,
      databaseUrl: '',
      origin: '',
      issuer: '',
      audience: '',
      proofAudience: '',
      signingKeyId: '',
      signingKeyPath: '',
      publicKeyRegistryPath: '',
      tokenTtlSeconds: '',
      proofTtlMs: '',
      bodyTimeoutMs: '',
    },
  },
  typescript: { strict: true },
  css: ['~/assets/main.css'],
})
