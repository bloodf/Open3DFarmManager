import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import {
  loadMigrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'
import {
  disposablePostgres,
  type DockerCommand,
} from '../helpers/disposable-postgres.ts'

/** One restricted login per capability, in the order the farm app consumes. */
export const CAPABILITIES = [
  'farm_password_auth',
  'farm_connector_inventory',
  'farm_browser_device_runtime',
  'farm_pairing_runtime',
  'farm_pairing_proof_runtime',
  'farm_connector_revoker',
  'farm_signalling_reader',
  'farm_connector_credential_acceptor',
  'farm_printer_ownership',
  'farm_configuration_authority',
  // Journey extras: signed control, telemetry ingestion, job history and network reader.
  'farm_pause_authority',
  'farm_connector_telemetry_writer',
  'farm_job_history_reader',
  'farm_printer_state_reader',
  // Print library (server storage mode), for the library and replay journeys.
  'farm_library',
] as const

export type Account = Readonly<{ id: string; username: string }>
export type JourneyDatabase = Readonly<{
  /** `postgres://<capability login>@127.0.0.1:<port>/fixture`. */
  url(capability: (typeof CAPABILITIES)[number]): string
  farmId: string
  password: string
  owner: Account
  admin: Account
  viewer: Account
  close(): Promise<void>
}>

/** A locally present PostgreSQL image. Used only when OPENFARM_PG=docker. */
export function selectPostgresImage(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.OPENFARM_PG === 'docker') {
    const requested = env.OPENFARM_JOURNEY_POSTGRES_IMAGE
    const listed = execFileSync(
      'docker',
      ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', 'postgres'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
      .split('\n')
      .filter((name) => /^postgres:(17|18)(?:[.-]|$)/.test(name))
    const image =
      requested ??
      listed.find((name) => name.startsWith('postgres:17')) ??
      listed.find((name) => !name.includes('alpine')) ??
      listed[0]
    if (!image)
      throw new Error(
        'No local PostgreSQL 17/18 image. Load one, or set OPENFARM_JOURNEY_POSTGRES_IMAGE. The journey harness never pulls images.',
      )
    execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return image
  }
  return undefined
}

/**
 * Starts a disposable PostgreSQL instance using the common provider:
 * throwaway local cluster by default (initdb + pg_ctl), OPENFARM_TEST_DATABASE_URL
 * if provided, or Docker when OPENFARM_PG=docker.
 * Migrated to current catalog, restricted capability logins, one farm and three accounts.
 */
export async function startJourneyDatabase(
  runId: string,
): Promise<JourneyDatabase> {
  const isDocker = process.env.OPENFARM_PG === 'docker'
  let dockerCmd: DockerCommand | undefined
  let image: string | undefined

  if (isDocker) {
    image = selectPostgresImage()
    dockerCmd = async (...args: string[]) =>
      execFileSync('docker', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      }).trim()
  }

  const name = `o3dfm-journey-${runId}`
  const labelKey = 'org.open3dfarmmanager.journey'
  const fixture = disposablePostgres({
    isolated: true,
    name,
    labelKey,
    labelValue: runId,
    port: 0,
    through: false,
    ...(isDocker ? { docker: dockerCmd, image } : {}),
  })

  let sql: ReturnType<typeof postgres> | undefined
  try {
    sql = await fixture.start()
    const port = fixture.port

    await runMigrations(sql, await loadMigrationCatalog(), { kind: 'up' })

    const prefix = 'jr' + randomBytes(6).toString('hex')
    const secrets = new Map(
      CAPABILITIES.map((capability) => [
        capability,
        randomBytes(24).toString('hex'),
      ]),
    )
    // One short, distinct login per capability (identifiers cap at 63 bytes).
    const login = (capability: (typeof CAPABILITIES)[number]) =>
      `${prefix}_${CAPABILITIES.indexOf(capability)}`
    for (const capability of CAPABILITIES)
      await sql.unsafe(
        `CREATE ROLE ${login(capability)} LOGIN PASSWORD '${secrets.get(capability)}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${capability}`,
      )
    const password = randomBytes(24).toString('hex')
    const hash = await hashPassword(password)
    const account = (kind: string): Account => ({
      id: randomUUID(),
      username: `${kind}_${randomBytes(8).toString('hex')}`,
    })
    const [owner, admin, viewer] = [
      account('owner'),
      account('admin'),
      account('viewer'),
    ] as [Account, Account, Account]
    const farmId = randomUUID()
    for (const { id, username } of [owner, admin, viewer]) {
      await sql`INSERT INTO farm.session_accounts(id) VALUES(${id})`
      await sql`INSERT INTO farm.password_credentials(account_id,username,password_hash) VALUES(${id},${username},${hash})`
    }
    await sql`INSERT INTO farm.farms(id) VALUES(${farmId}::uuid)`
    await sql`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farmId}::uuid,${owner.id},'owner'),(${farmId}::uuid,${admin.id},'admin'),(${farmId}::uuid,${viewer.id},'viewer')`
    await sql.end({ timeout: 3 })
    sql = undefined

    return Object.freeze({
      url: (capability) =>
        `postgres://${login(capability)}:${secrets.get(capability)}@127.0.0.1:${port}/fixture`,
      farmId,
      password,
      owner,
      admin,
      viewer,
      async close() {
        await fixture.stop()
      },
    })
  } catch (error) {
    await sql?.end({ timeout: 3 }).catch(() => {})
    await fixture.stop().catch(() => {})
    throw error
  }
}
