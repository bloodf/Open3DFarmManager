import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const roles = {
  DATABASE_DATABASE_URL: 'farm_schema_reader',
  AUTH_DATABASE_URL: 'farm_account_registration',
  CONNECTOR_PAIRING_DATABASE_URL: 'farm_pairing_runtime',
  CONNECTOR_PAIRING_PROOF_DATABASE_URL: 'farm_pairing_proof_runtime',
  CONNECTOR_PAIRING_REVOCATION_DATABASE_URL: 'farm_connector_revoker',
  CONNECTOR_TELEMETRY_DATABASE_URL: 'farm_connector_telemetry_writer',
  CONNECTOR_RENEWAL_DATABASE_URL: 'farm_connector_credential_renewer',
  CONNECTOR_INVENTORY_DATABASE_URL: 'farm_connector_inventory',
  BROWSER_DEVICES_DATABASE_URL: 'farm_browser_device_runtime',
  PRINTER_ASSIGNMENTS_DATABASE_URL: 'farm_printer_ownership',
  PRINTER_STATES_DATABASE_URL: 'farm_printer_state_reader',
  JOB_HISTORY_DATABASE_URL: 'farm_job_history_reader',
  PAUSE_AUTHORITY_DATABASE_URL: 'farm_pause_authority',
} as const

const randomSecret = () => randomBytes(32).toString('base64url')

function databaseTarget(value: string) {
  const url = new URL(value)
  const sslModes = [
    'disable',
    'allow',
    'prefer',
    'require',
    'verify-ca',
    'verify-full',
  ]
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    !/^\/[^/]+$/.test(url.pathname) ||
    url.hash ||
    [...url.searchParams].some(
      ([key, mode]) => key !== 'sslmode' || !sslModes.includes(mode),
    ) ||
    url.searchParams.size > 1 ||
    value.length > 1800 ||
    /["$\\]/.test(url.pathname)
  )
    throw new Error('Invalid PostgreSQL provisioning URL')
  return url
}

async function readPrivate(path: string, secondLink?: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await file.stat()
    const sibling =
      stat.nlink === 2 && secondLink ? await lstat(secondLink) : undefined
    const ownedLinks =
      stat.nlink === 1 ||
      (sibling?.ino === stat.ino && sibling.dev === stat.dev)
    if (
      !stat.isFile() ||
      !ownedLinks ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 32768
    )
      throw new Error('Unsafe initialization file')
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

function missing(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

async function generate(directory: string, origin: string, admin: URL) {
  const write = (name: string, body: string) =>
    writeFile(join(directory, name), body, { flag: 'wx', mode: 0o600 })
  const pairing = generateKeyPairSync('ed25519')
  const renewal = generateKeyPairSync('ed25519')
  const pause = generateKeyPairSync('ed25519')
  const issuer = 'open3dfarmmanager'
  const audience = 'open3dfarmmanager:connector'
  const pauseKid = 'pause-v1'
  await write(
    'pairing.pem',
    pairing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  )
  await write(
    'renewal.pem',
    renewal.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  )
  await write(
    'pause.json',
    JSON.stringify({
      version: 1,
      issuer,
      kid: pauseKid,
      privateKeyPkcs8: pause.privateKey
        .export({ type: 'pkcs8', format: 'der' })
        .toString('base64url'),
    }),
  )
  await write(
    'verification-keys.json',
    JSON.stringify({
      'pairing-v1': pairing.publicKey.export({ type: 'spki', format: 'pem' }),
      'renewal-v1': renewal.publicKey.export({ type: 'spki', format: 'pem' }),
    }),
  )

  const values: Record<string, string> = {
    DATABASE_MIGRATIONS: 'verify',
    DATABASE_MIGRATIONS_DIR: '/app/migrations',
    AUTH_ORIGIN: origin,
    AUTH_SESSION_SECRET: randomSecret(),
    AUTH_BOOTSTRAP_TOKEN: randomSecret(),
    CONNECTOR_PAIRING_SIGNING_KEY_ID: 'pairing-v1',
    CONNECTOR_PAIRING_SIGNING_KEY_PATH: join(directory, 'pairing.pem'),
    CONNECTOR_RENEWAL_SIGNING_KEY_ID: 'renewal-v1',
    CONNECTOR_RENEWAL_SIGNING_KEY_PATH: join(directory, 'renewal.pem'),
    CONNECTOR_RENEWAL_PROOF_AUDIENCE: 'open3dfarmmanager:renewal',
    PAUSE_AUTHORITY_ISSUER: issuer,
    PAUSE_AUTHORITY_KID: pauseKid,
    PAUSE_AUTHORITY_AUDIENCE: 'open3dfarmmanager:pause',
    PAUSE_AUTHORITY_CREDENTIAL_ISSUER: issuer,
    PAUSE_AUTHORITY_CREDENTIAL_AUDIENCE: audience,
    PAUSE_AUTHORITY_ISSUER_KEY_PATH: join(directory, 'pause.json'),
    PAUSE_AUTHORITY_ISSUER_PUBLIC_KEY_SPKI: pause.publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64url'),
  }
  for (const feature of [
    'CONNECTOR_PAIRING',
    'CONNECTOR_TELEMETRY',
    'CONNECTOR_RENEWAL',
  ]) {
    values[feature + '_ORIGIN'] = origin
    values[feature + '_ISSUER'] = issuer
    values[feature + '_AUDIENCE'] = audience
    values[feature + '_TOKEN_TTL_SECONDS'] = '300'
  }
  for (const feature of ['CONNECTOR_TELEMETRY', 'CONNECTOR_RENEWAL']) {
    values[feature + '_PUBLIC_KEY_REGISTRY_PATH'] = join(
      directory,
      'verification-keys.json',
    )
    values[feature + '_PROOF_TTL_MS'] = '30000'
    values[feature + '_BODY_TIMEOUT_MS'] = '5000'
  }
  const installation = randomBytes(8).toString('hex')
  for (const [name, role] of Object.entries(roles)) {
    const url = new URL(admin)
    url.username = `o3dfm_${installation}_${role.slice(5)}`
    url.password = randomSecret()
    values[name] = url.href
    if (
      ![
        'CONNECTOR_PAIRING_PROOF_DATABASE_URL',
        'CONNECTOR_PAIRING_REVOCATION_DATABASE_URL',
      ].includes(name)
    )
      values[name.replace(/_DATABASE_URL$/, '_ENABLED')] = 'true'
  }
  return Object.entries(values)
    .map(([key, value]) => `NUXT_${key}="${value}"\n`)
    .join('')
}

type Provision = (admin: URL, sql: string) => void

function psql(admin: URL, sql: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('PG') && key !== 'OPENFARM_INIT_DATABASE_URL',
    ),
  )
  const result = spawnSync('psql', ['-X', '-w', '-v', 'ON_ERROR_STOP=1'], {
    env: {
      ...env,
      PGHOST: admin.hostname.replace(/^\[|\]$/g, ''),
      PGPORT: admin.port || '5432',
      PGDATABASE: decodeURIComponent(admin.pathname.slice(1)),
      PGUSER: decodeURIComponent(admin.username),
      PGPASSWORD: decodeURIComponent(admin.password),
      PGSSLMODE: admin.searchParams.get('sslmode') ?? 'prefer',
      PGCONNECT_TIMEOUT: '5',
    },
    input: sql,
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 60000,
  })
  if (result.status !== 0)
    throw new Error(
      'Database provisioning failed. Check psql, connectivity, migrations and role privileges. Retry with the same directory.',
    )
}

function roleSql(env: Record<string, string>, admin: URL) {
  const statements = Object.entries(roles).map(([key, role]) => {
    const url = databaseTarget(env['NUXT_' + key] ?? '')
    const login = url.username
    if (
      !new RegExp(`^o3dfm_[a-f0-9]{16}_${role.slice(5)}$`).test(login) ||
      !/^[A-Za-z0-9_-]{43}$/.test(url.password) ||
      url.host !== admin.host ||
      url.pathname !== admin.pathname ||
      url.search !== admin.search
    )
      throw new Error(
        'Pending initialization does not match the database target',
      )
    // A marker allows recovery if PostgreSQL committed before app.env was published.
    const marker = createHash('sha256').update(url.password).digest('hex')
    return `
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${login}') THEN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${login}'
          AND shobj_description(oid, 'pg_authid') = 'openfarm-init:${marker}') THEN
          RAISE EXCEPTION 'Initialization login already exists';
        END IF;
      ELSE
        CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${url.password}';
        GRANT ${role} TO ${login};
        COMMENT ON ROLE ${login} IS 'openfarm-init:${marker}';
      END IF;`
  })
  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(781029245);
DO $init$
BEGIN
${statements.join('\n')}
END;
$init$;
COMMIT;\n`
}

export async function initialize(
  directory: string,
  origin: string,
  databaseUrl: string,
  provision: Provision = psql,
) {
  directory = resolve(directory)
  if (!/^[/a-zA-Z0-9._ -]+$/.test(directory) || directory.length > 1950)
    throw new Error('Invalid initialization directory')
  const target = new URL(origin)
  if (
    target.protocol !== 'https:' ||
    target.origin !== origin ||
    origin.length > 256
  )
    throw new Error('Expected a canonical HTTPS origin')
  const admin = databaseTarget(databaseUrl)
  const pending = join(directory, '.init-pending')
  const output = join(directory, 'app.env')
  if (!(await exists(directory))) {
    await mkdir(directory, { mode: 0o700 })
    const contents = await generate(directory, origin, admin)
    await writeFile(pending, contents, { flag: 'wx', mode: 0o600 })
  }
  const stat = await lstat(directory)
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('Expected an owner-private initialization directory')

  if (await exists(output)) {
    const env = parseEnv(await readPrivate(output, pending))
    if (env.NUXT_AUTH_ORIGIN !== origin)
      throw new Error('Existing initialization does not match the HTTPS origin')
    roleSql(env, admin)
    if (await exists(pending)) {
      const [published, staged] = await Promise.all([
        lstat(output),
        lstat(pending),
      ])
      if (published.ino === staged.ino && published.dev === staged.dev)
        await unlink(pending)
    }
    return
  }
  if (!(await exists(pending)))
    throw new Error(
      'Existing directory has no pending initialization. Use a new directory.',
    )
  const env = parseEnv(await readPrivate(pending))
  if (env.NUXT_AUTH_ORIGIN !== origin)
    throw new Error('Pending initialization does not match the HTTPS origin')
  for (const name of [
    'pairing.pem',
    'renewal.pem',
    'pause.json',
    'verification-keys.json',
  ])
    await readPrivate(join(directory, name))
  provision(admin, roleSql(env, admin))
  // The hard link provides an exclusive, atomic publish within the private directory.
  await link(pending, output)
  await unlink(pending)
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [directory, origin, ...extra] = process.argv.slice(2)
  const databaseUrl = process.env.OPENFARM_INIT_DATABASE_URL
  if (!directory || !origin || !databaseUrl || extra.length) {
    console.error(
      'Usage: set OPENFARM_INIT_DATABASE_URL privately, then run node scripts/self-host/init.ts <new-private-directory> <https-origin>. Apply database migrations first.',
    )
    process.exitCode = 1
  } else {
    try {
      await initialize(directory, origin, databaseUrl)
      console.log(
        'Initialization ready. Load app.env and give the server read access to the key files at their configured paths.',
      )
    } catch {
      console.error(
        'Initialization failed. Check the private directory, HTTPS origin and database provisioning prerequisites. Existing secrets are preserved.',
      )
      process.exitCode = 1
    }
  }
}
