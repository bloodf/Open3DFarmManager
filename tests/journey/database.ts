import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import {
  loadMigrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'

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
  // Journey extras: signed control, telemetry ingestion and job history.
  'farm_pause_authority',
  'farm_connector_telemetry_writer',
  'farm_job_history_reader',
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

const docker = (args: string[], timeout = 60_000) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

/** A locally present PostgreSQL image. Never pulls; the owner of an image keeps it. */
export function selectPostgresImage(env: NodeJS.ProcessEnv = process.env) {
  const requested = env.OPENFARM_JOURNEY_POSTGRES_IMAGE
  const listed = docker([
    'image',
    'ls',
    '--format',
    '{{.Repository}}:{{.Tag}}',
    'postgres',
  ])
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
  docker(['image', 'inspect', image, '--format', '{{.Id}}'])
  return image
}

/**
 * A task-owned, labelled, disposable PostgreSQL container: official migrations,
 * restricted capability logins, one farm and three accounts. The container is
 * removed (with its anonymous volumes) by `close`.
 */
export async function startJourneyDatabase(
  runId: string,
): Promise<JourneyDatabase> {
  const image = selectPostgresImage()
  const name = `o3dfm-journey-${runId}`
  const label = `org.open3dfarmmanager.journey=${runId}`
  const remove = () => {
    try {
      docker(['rm', '--volumes', '--force', name], 30_000)
    } catch {
      /* Not created or already removed. */
    }
  }
  let sql: ReturnType<typeof postgres> | undefined
  try {
    docker([
      ...['create', '--name', name, '--label', label, '--pull', 'never'],
      ...['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'],
      ...['--user', 'postgres'],
      ...['--tmpfs', '/var/lib/postgresql/data:rw,mode=1777'],
      ...['--tmpfs', '/var/run/postgresql:rw,mode=1777'],
      ...['--tmpfs', '/tmp:rw,mode=1777'],
      ...['-p', '127.0.0.1::5432'],
      ...['-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_DB=fixture'],
      ...['-e', 'POSTGRES_HOST_AUTH_METHOD=trust'],
      ...['-e', 'PGDATA=/var/lib/postgresql/data/pgdata'],
      image,
    ])
    docker(['start', name])
    docker(
      [
        ...['exec', name, 'sh', '-c'],
        'n=0; until pg_isready -U fixture -d fixture >/dev/null && psql -U fixture -d fixture -c "SELECT 1" >/dev/null 2>&1; do n=$((n+1)); [ "$n" -lt 60 ] || exit 1; sleep 1; done',
      ],
      90_000,
    )
    const mapping = docker(['port', name, '5432/tcp']).split('\n')[0] ?? ''
    const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1))
    if (!Number.isInteger(port) || port < 1024)
      throw new Error('PostgreSQL host port unavailable')
    sql = postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username: 'fixture',
      max: 2,
      connect_timeout: 5,
    })
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
        // A loaded host can take longer than one removal attempt.
        for (let attempt = 0; attempt < 5; attempt++) {
          remove()
          if (docker(['ps', '-aq', '--filter', `label=${label}`]) === '') return
        }
        throw new Error('Journey PostgreSQL container remains')
      },
    })
  } catch (error) {
    await sql?.end({ timeout: 3 }).catch(() => {})
    remove()
    throw error
  }
}
