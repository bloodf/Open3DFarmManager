import { randomBytes, X509Certificate } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres, { type Sql } from 'postgres'
import { IntegrationAppsService } from '../apps/farm/server/services/integration-apps.ts'
import { PostgresIntegrationApps } from '../apps/farm/server/storage/integration-apps-postgres.ts'
import { loadOrCreateIdentity } from '../packages/connector/src/identity/store.ts'
import { syntheticBambuCertificate } from '../infra/sandbox/bambu-synthetic-identity.ts'
import {
  enrollConnector,
  ENROLLMENT,
} from '../tests/helpers/connector-enrollment.ts'
import { loadMigrationCatalog, runMigrations } from './db/migrations.ts'

const origin = 'https://app:3000'
const moonraker = 'http://klipper:7125'
const printerKeys = ['sandbox-klipper', 'sandbox-bambu']

export async function seedSandbox(admin: Sql, databaseUrl: URL, state: string) {
  const write = (name: string, value: object | string) =>
    writeFile(
      join(state, name),
      typeof value === 'string' ? value : JSON.stringify(value),
      { mode: 0o600 },
    )
  await runMigrations(admin, await loadMigrationCatalog(), { kind: 'up' })

  const groups = {
    sandbox_pair: 'farm_pairing_runtime',
    sandbox_owner: 'farm_printer_ownership',
    sandbox_telemetry: 'farm_connector_telemetry_writer',
    sandbox_integrations: 'farm_integration_apps',
    sandbox_verify: undefined,
  }
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
  await admin`GRANT SELECT ON public.open3dfarm_migrations TO sandbox_verify`
  const pool = (role: string) =>
    postgres(urls.get(role)!.href, { max: 1, ssl: false })
  const pairSql = pool('sandbox_pair')
  const ownerSql = pool('sandbox_owner')
  const integrationSql = pool('sandbox_integrations')
  try {
    const identity = loadOrCreateIdentity(join(state, 'connector-data'))
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
      scopes: ['printers:read', 'inventory:read'],
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
              allowedEndpoints: [{ host: '127.0.0.1', port: 9999 }],
              credentialFile: '/sandbox/bambu-credential.json',
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
      url.hostname = 'postgres'
      url.port = '5432'
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
        'NUXT_DATABASE_MIGRATIONS_DIR=/workspace/infra/db/migrations',
        'NUXT_DATABASE_DATABASE_URL=' + internalUrl('sandbox_verify'),
        'NUXT_CONNECTOR_TELEMETRY_ENABLED=true',
        'NUXT_CONNECTOR_TELEMETRY_DATABASE_URL=' +
          internalUrl('sandbox_telemetry'),
        'NUXT_CONNECTOR_TELEMETRY_ORIGIN=' + origin,
        'NUXT_CONNECTOR_TELEMETRY_ISSUER=' + ENROLLMENT.issuer,
        'NUXT_CONNECTOR_TELEMETRY_AUDIENCE=' + ENROLLMENT.audience,
        'NUXT_CONNECTOR_TELEMETRY_PUBLIC_KEY_REGISTRY_PATH=/sandbox/keys.json',
        'NUXT_CONNECTOR_TELEMETRY_TOKEN_TTL_SECONDS=' + ENROLLMENT.ttlSeconds,
        'NUXT_CONNECTOR_TELEMETRY_PROOF_TTL_MS=30000',
        'NUXT_CONNECTOR_TELEMETRY_BODY_TIMEOUT_MS=5000',
        'NUXT_INTEGRATION_AUTH_ENABLED=true',
        'NUXT_INTEGRATION_AUTH_DATABASE_URL=' +
          internalUrl('sandbox_integrations'),
        'NUXT_INTEGRATION_AUTH_SIGNING_KEY=' +
          randomBytes(32).toString('base64url'),
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
