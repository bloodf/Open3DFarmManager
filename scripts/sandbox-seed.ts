import { randomBytes, X509Certificate } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres, { type Sql } from 'postgres'
import { IntegrationAppsService } from '../apps/farm/server/services/integration-apps.ts'
import { PostgresIntegrationApps } from '../apps/farm/server/storage/integration-apps-postgres.ts'
import { INITIAL_COLLECTION_ATTEMPT } from '../packages/connector/src/control/queue-collection-journal.ts'
import { loadOrCreateIdentity } from '../packages/connector/src/identity/store.ts'
import { syntheticBambuCertificate } from '../infra/sandbox/bambu-synthetic-identity.ts'
import { API_ENVELOPE_ISSUER } from '../packages/farm-protocol/src/api-envelope.ts'
import {
  encodeTrustedKeySetFrame,
  signTrustedKeySet,
} from '../packages/farm-protocol/src/trusted-keys.ts'
import {
  enrollConnector,
  ENROLLMENT,
} from '../tests/helpers/connector-enrollment.ts'

const printerKeys = ['sandbox-klipper', 'sandbox-bambu']

export async function seedSandbox(
  admin: Sql,
  databaseUrl: URL,
  state: string,
  options: { origin?: string; moonraker?: string; local?: boolean } = {},
) {
  // The seed directory contains credentials and may be supplied by an
  // operator, so enforce its privacy even when it already exists.
  await mkdir(state, { recursive: true, mode: 0o700 })
  await chmod(state, 0o700)
  const connectorData = join(state, 'connector-data')
  await mkdir(connectorData, { recursive: true, mode: 0o700 })
  await chmod(connectorData, 0o700)
  const origin = options.origin ?? 'https://app:3000'
  const moonraker = options.moonraker ?? 'http://klipper:7125'
  const sandboxPath = (name: string) =>
    options.local ? join(state, name) : `/sandbox/${name}`
  const write = (name: string, value: object | string) =>
    writeFile(
      join(state, name),
      typeof value === 'string' ? value : JSON.stringify(value),
      { mode: 0o600 },
    )
  const groups = {
    sandbox_pair: 'farm_pairing_runtime',
    sandbox_owner: 'farm_printer_ownership',
    sandbox_telemetry: 'farm_connector_telemetry_writer',
    sandbox_integrations: 'farm_integration_apps',
    sandbox_auth: 'farm_password_auth',
    sandbox_signal: 'farm_signalling_reader',
    sandbox_signal_proof: 'farm_connector_credential_acceptor',
    sandbox_library: 'farm_library',
    sandbox_jobs: undefined,
    sandbox_verify: undefined,
  }
  const envelopeKeys = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  const envelopeSigningKey = Buffer.from(
    await crypto.subtle.exportKey('pkcs8', envelopeKeys.privateKey),
  ).toString('base64url')
  const envelopeKid = randomBytes(16).toString('hex')
  await write('integration-envelope.json', {
    kid: envelopeKid,
    privateKey: envelopeSigningKey,
    publicKeySpki: Buffer.from(
      await crypto.subtle.exportKey('spki', envelopeKeys.publicKey),
    ).toString('base64url'),
  })
  const urls = new Map<string, URL>()
  for (const [user, group] of Object.entries(groups)) {
    const url = new URL(databaseUrl)
    url.username = user
    url.password = randomBytes(24).toString('hex')
    await admin`CREATE ROLE ${admin(user)} LOGIN`
    await admin.unsafe(`ALTER ROLE "${user}" PASSWORD '${url.password}'`)
    if (group) await admin`GRANT ${admin(group)} TO ${admin(user)}`
    urls.set(user, url)
  }
  await admin`GRANT farm_integration_jobs, farm_integration_approvals, farm_integration_delivery TO sandbox_jobs`
  await admin`GRANT SELECT ON public.open3dfarm_migrations TO sandbox_verify`
  const pool = (role: string) =>
    postgres(urls.get(role)!.href, { max: 1, ssl: false })
  const pairSql = pool('sandbox_pair')
  const ownerSql = pool('sandbox_owner')
  const integrationSql = pool('sandbox_integrations')
  try {
    const identity = loadOrCreateIdentity(connectorData)
    const enrolled = await enrollConnector({
      admin,
      pairSql,
      ownerSql,
      identity,
      origin,
      workDir: state,
      printerKeys,
      sandbox: true,
    })
    const [owner] = await admin<{ account_id: string }[]>`
      SELECT account_id FROM farm.memberships WHERE farm_id = ${enrolled.farmId}::uuid AND role = 'owner'
    `
    const api = new IntegrationAppsService(
      new PostgresIntegrationApps(integrationSql),
    )
    const app = await api.createApp(owner!.account_id, {
      farmId: enrolled.farmId,
      name: 'Sandbox',
      sandbox: true,
    })
    if (typeof app !== 'object') throw new Error(app)
    const grant = await api.createGrant(owner!.account_id, {
      appId: app.id,
      farmId: enrolled.farmId,
      scopes: [
        'printers:read',
        'inventory:read',
        'files:read',
        'jobs:read',
        'jobs:start',
        'control:basic',
        'control:extended',
      ],
    })
    if (typeof grant !== 'object') throw new Error(grant)
    const issued = await api.issueCredential(owner!.account_id, app.id)
    if (typeof issued !== 'object') throw new Error(issued)

    const assignment = (index: number) => ({
      assignment_id: enrolled.assignments[index]!.assignmentId,
      farm_id: enrolled.farmId,
      agent_id: enrolled.agentId,
      printer_key: printerKeys[index],
    })
    const publicKeySpki = Buffer.from(
      await crypto.subtle.exportKey('spki', envelopeKeys.publicKey),
    ).toString('base64url')
    const signer = await crypto.subtle.importKey(
      'pkcs8',
      Buffer.from(envelopeSigningKey, 'base64url'),
      'Ed25519',
      false,
      ['sign'],
    )
    const keySet = await signTrustedKeySet(
      {
        v: 1,
        purpose: 'trusted-key-set',
        farm_id: enrolled.farmId,
        version: 1,
        issued_at: Date.now(),
        issuer: API_ENVELOPE_ISSUER,
        kid: envelopeKid,
        issuer_keys: [
          {
            issuer: API_ENVELOPE_ISSUER,
            kid: envelopeKid,
            public_key_spki: publicKeySpki,
          },
        ],
        browser_keys: [],
      },
      signer,
    )
    await write(
      'connector-data/trusted-keys.json',
      encodeTrustedKeySetFrame({
        v: 1,
        t: 'trusted-keys.set',
        key_set: keySet,
      }),
    )
    // The sandbox provisions an empty simulated Klipper bed. Keep any
    // existing journal so reseeding cannot clear a later simulated run.
    try {
      await writeFile(
        join(connectorData, 'queue-collection.json'),
        JSON.stringify({
          version: 1,
          printers: {
            [printerKeys[0]!]: {
              attempts: [
                { id: INITIAL_COLLECTION_ATTEMPT, status: 'collected' },
              ],
            },
          },
        }),
        { mode: 0o600, flag: 'wx' },
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await write('runtime.json', {
      version: 3,
      collection: {
        version: 3,
        allowedOrigins: [moonraker],
        printers: [{ printerKey: printerKeys[0], origin: moonraker }],
        limits: { staleAfterMs: 300000, connectTimeoutMs: 3000 },
        bambu: {
          printers: [
            {
              printerKey: printerKeys[1],
              host: '127.0.0.1',
              port: 9999,
              serial: 'SYNTHETIC',
              control: true,
              model: 'synthetic',
              ftpsPort: 9998,
              allowedEndpoints: [{ host: '127.0.0.1', port: 9999 }],
              credentialFile: sandboxPath('bambu-credential.json'),
              pinSha256: new X509Certificate(
                syntheticBambuCertificate,
              ).fingerprint256
                .replaceAll(':', '')
                .toLowerCase(),
            },
          ],
        },
      },
      assignments: [
        { ...assignment(0), moonraker_origin: moonraker },
        assignment(1),
      ],
      signalling: {
        endpoint:
          origin.replace(/^https:/, 'wss:') + '/api/signalling/connector',
        origin,
        audience: ENROLLMENT.audience,
      },
      pause: {
        version: 1,
        issuers: [
          { issuer: API_ENVELOPE_ISSUER, kid: envelopeKid, publicKeySpki },
        ],
        control: {
          assignmentIds: enrolled.assignments.map((item) => item.assignmentId),
        },
        signalling: {
          endpoint:
            origin.replace(/^https:/, 'wss:') +
            '/api/signalling/pause-connector',
          origin,
          audience: 'open3dfarmmanager:pause',
          credentialAudience: ENROLLMENT.audience,
        },
      },
      telemetry: {
        endpoint: origin + '/api/connector/telemetry',
        audience: ENROLLMENT.audience,
      },
    })
    await write('bambu-credential.json', {
      accessCode: randomBytes(16).toString('hex'),
    })
    await write('credential.json', {
      version: 1,
      expected_fingerprint: identity.fingerprint,
      approval: enrolled.approval,
    })

    const internalUrl = (role: string) => {
      const url = new URL(urls.get(role)!.href)
      if (!options.local) {
        url.hostname = 'postgres'
        url.port = '5432'
      }
      return url.href
    }
    await write(
      'app.env',
      [
        'NODE_ENV=production',
        'NITRO_HOST=0.0.0.0',
        'NITRO_PORT=3000',
        'NUXT_DATABASE_ENABLED=true',
        'NUXT_DATABASE_MIGRATIONS=verify',
        'NUXT_DATABASE_MIGRATIONS_DIR=' +
          (options.local
            ? join(process.cwd(), 'infra/db/migrations')
            : '/workspace/infra/db/migrations'),
        'NUXT_DATABASE_DATABASE_URL=' + internalUrl('sandbox_verify'),
        'NUXT_AUTH_ENABLED=true',
        'NUXT_AUTH_ORIGIN=' + origin,
        'NUXT_AUTH_SESSION_SECRET=' + randomBytes(32).toString('hex'),
        'NUXT_AUTH_DATABASE_URL=' + internalUrl('sandbox_auth'),
        'NUXT_CONNECTOR_SIGNALLING_ENABLED=true',
        'NUXT_CONNECTOR_SIGNALLING_ORIGIN=' + origin,
        'NUXT_CONNECTOR_SIGNALLING_ISSUER=' + ENROLLMENT.issuer,
        'NUXT_CONNECTOR_SIGNALLING_AUDIENCE=' + ENROLLMENT.audience,
        'NUXT_CONNECTOR_SIGNALLING_READER_DATABASE_URL=' +
          internalUrl('sandbox_signal'),
        'NUXT_CONNECTOR_SIGNALLING_PROOF_DATABASE_URL=' +
          internalUrl('sandbox_signal_proof'),
        'NUXT_CONNECTOR_SIGNALLING_PUBLIC_KEY_REGISTRY_PATH=' +
          sandboxPath('keys.json'),
        'NUXT_CONNECTOR_SIGNALLING_TOKEN_TTL_SECONDS=' + ENROLLMENT.ttlSeconds,
        'NUXT_CONNECTOR_SIGNALLING_PROOF_TTL_MS=8000',
        'NUXT_CONNECTOR_TELEMETRY_ENABLED=true',
        'NUXT_CONNECTOR_TELEMETRY_DATABASE_URL=' +
          internalUrl('sandbox_telemetry'),
        'NUXT_CONNECTOR_TELEMETRY_ORIGIN=' + origin,
        'NUXT_CONNECTOR_TELEMETRY_ISSUER=' + ENROLLMENT.issuer,
        'NUXT_CONNECTOR_TELEMETRY_AUDIENCE=' + ENROLLMENT.audience,
        'NUXT_CONNECTOR_TELEMETRY_PUBLIC_KEY_REGISTRY_PATH=' +
          sandboxPath('keys.json'),
        'NUXT_CONNECTOR_TELEMETRY_TOKEN_TTL_SECONDS=' + ENROLLMENT.ttlSeconds,
        'NUXT_CONNECTOR_TELEMETRY_PROOF_TTL_MS=30000',
        'NUXT_CONNECTOR_TELEMETRY_BODY_TIMEOUT_MS=5000',
        'NUXT_INTEGRATION_AUTH_ENABLED=true',
        'NUXT_INTEGRATION_AUTH_DATABASE_URL=' +
          internalUrl('sandbox_integrations'),
        'NUXT_INTEGRATION_AUTH_SIGNING_KEY=' +
          randomBytes(32).toString('base64url'),
        'NUXT_LIBRARY_ENABLED=true',
        'NUXT_LIBRARY_DATABASE_URL=' + internalUrl('sandbox_library'),
        'NUXT_INTEGRATION_JOBS_DATABASE_URL=' + internalUrl('sandbox_jobs'),
        'NUXT_INTEGRATION_JOBS_ENABLED=true',
        'NUXT_INTEGRATION_JOBS_ENVELOPE_SIGNING_KEY=' + envelopeSigningKey,
        'NUXT_INTEGRATION_JOBS_ENVELOPE_KID=' + envelopeKid,
      ].join('\n') + '\n',
    )
    await write('client.json', {
      clientId: issued.credential.clientId,
      clientSecret: issued.secret,
      printerId: assignment(0).assignment_id,
      farmId: enrolled.farmId,
    })
  } finally {
    await Promise.all([pairSql.end(), ownerSql.end(), integrationSql.end()])
  }
}
