import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, cp, rm, statfs } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'
import postgres from 'postgres'
import { registrationAdmission } from '../tests/helpers/kobralink-rtc/admission.ts'
import { loadMigrationCatalog, runMigrations } from './db/migrations.ts'
import { createSyntheticTls } from '../tests/fixtures/kobralink-integration/tls.ts'

const checkout = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const options = registrationAdmission(process.env, checkout)
assert.equal(process.argv.length, 2)
const id = randomUUID()
const name = 'o3dfm-kobra-rtc-' + id
const root = join(options.evidence, id)
await mkdir(root, { mode: 0o700, recursive: true })
const ledger = async (event: object) => {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(
    join(root, 'resources.jsonl'),
    JSON.stringify(event) + '\n',
    { mode: 0o600 },
  )
}
const context = 'colima-openfarm-kobralink-togiej'
const docker = (...args: string[]) =>
  execFileSync('docker', ['--context', context, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  })
const children = new Set<ReturnType<typeof spawn>>()
async function run(
  step: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  cwd = checkout,
) {
  const output = createWriteStream(join(root, step + '.log'), { mode: 0o600 })
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  await ledger({ process: step, pid: child.pid })
  child.stdout?.pipe(output, { end: false })
  child.stderr?.pipe(output, { end: false })
  const stop = () => {
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
  }
  const timer = setTimeout(stop, timeout)
  const kill = setTimeout(() => {
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
  }, timeout + 5000)
  try {
    const [code] = await once(child, 'close')
    assert.equal(code, 0, `${step} failed; read private log`)
  } finally {
    clearTimeout(timer)
    clearTimeout(kill)
    children.delete(child)
    await new Promise<void>((resolve) => output.end(resolve))
  }
}
const containers: string[] = []
let network = false
let sql: ReturnType<typeof postgres> | undefined
const stop = () => {
  for (const child of children)
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try {
  const free = await statfs(checkout, { bigint: true })
  assert.ok(free.bavail * free.bsize > 10n * 1024n ** 3n)
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
    '',
    'Sealed source must be committed',
  )
  await ledger({
    head: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    diskFree: String(free.bavail * free.bsize),
    worktrees: execFileSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    }),
  })
  assert.equal(
    execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim(),
    'orbstack',
  )
  // Restart v3 is an explicit operator prerequisite. Verify both rules again.
  for (const args of [
    ['-s', '172.30.77.0/24'],
    ['-s', '172.30.78.0/24', '!', '-d', '172.30.78.0/24'],
  ])
    execFileSync(
      'limactl',
      [
        'shell',
        'colima-openfarm-kobralink-togiej',
        'sudo',
        'iptables',
        '-C',
        'DOCKER-USER',
        ...args,
        '-m',
        'conntrack',
        '--ctstate',
        'NEW',
        '-j',
        'DROP',
      ],
      {
        env: {
          ...process.env,
          LIMA_HOME: join(process.env.HOME ?? '', '.colima/_lima'),
        },
        timeout: 15000,
      },
    )
  const pinned =
    'sha256:9865baa7346eb87d8860ced1881c30a1e5600b979d618c44757228407dce22e3'
  assert.equal(
    docker(
      'image',
      'inspect',
      options.kobraImage,
      '--format',
      '{{.Id}}',
    ).trim(),
    pinned,
  )
  docker('image', 'inspect', options.postgresImage)
  // No subnet reuse: an existing network in this range refuses this run.
  docker(
    'network',
    'create',
    '--subnet',
    '172.30.78.0/24',
    '--label',
    `org.openfarm.rtc=${id}`,
    name,
  )
  network = true
  await ledger({ network: name })
  const tls = createSyntheticTls()
  const synthetic = join(root, 'synthetic')
  await cp(join(checkout, 'tests/fixtures/kobralink-integration'), synthetic, {
    recursive: true,
  })
  await writeFile(join(synthetic, 'key.pem'), tls.key, { mode: 0o600 })
  await writeFile(join(synthetic, 'cert.pem'), tls.cert, { mode: 0o600 })
  async function create(suffix: string, args: string[]) {
    const n = name + '-' + suffix
    await ledger({ container: n })
    // Record before create so timeout cleanup can recover this exact labelled name.
    containers.push(n)
    docker(
      'create',
      '--name',
      n,
      '--label',
      `org.openfarm.rtc=${id}`,
      '--pull',
      'never',
      ...args,
    )
    return n
  }
  const printer = await create('printer', [
    '--user',
    `${process.getuid?.()}:${process.getgid?.()}`,
    '--network',
    name,
    '--ip',
    '172.30.78.3',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-e',
    'OPENFARM_SYNTHETIC_KOBRA_NETWORK=owned-isolated',
    '--entrypoint',
    'bun',
    options.kobraImage,
    '/fixture/serve.ts',
  ])
  docker('cp', synthetic + '/.', printer + ':/fixture')
  docker('start', printer)
  docker(
    'exec',
    printer,
    'bun',
    '-e',
    `let ok=false;for(let n=0;n<30;n++){try{ok=(await fetch('http://127.0.0.1:18910/info')).ok;if(ok)break}catch{}await Bun.sleep(100)}if(!ok)process.exit(1)`,
  )
  const bridge = await create('bridge', [
    '--network',
    name,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/data:rw,mode=1777',
    '-p',
    `127.0.0.1:${options.ports[2]}:7100`,
    '-e',
    'NODE_ENV=production',
    '-e',
    'KOBRALINK_DATA_DIR=/data',
    '-e',
    'DATABASE_URL=file:/data/kobralink.db',
    '-e',
    'KOBRALINK_PORT=7100',
    '-e',
    'KOBRALINK_UPDATE_REPO=',
    '-e',
    'KOBRALINK_EXTRA_ORIGINS=',
    '-e',
    `BETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}`,
    '-e',
    `BETTER_AUTH_URL=http://127.0.0.1:${options.ports[2]}`,
    options.kobraImage,
  ])
  docker('start', bridge)
  const db = await create('db', [
    '--network',
    name,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    'postgres',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,mode=1777',
    '--tmpfs',
    '/var/run/postgresql:rw,mode=1777',
    '-p',
    `127.0.0.1:${options.ports[0]}:5432`,
    '-e',
    'POSTGRES_USER=fixture',
    '-e',
    'POSTGRES_DB=fixture',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'PGDATA=/var/lib/postgresql/data/pgdata',
    options.postgresImage,
  ])
  docker('start', db)
  docker(
    'exec',
    db,
    'sh',
    '-c',
    'n=0; until pg_isready -U fixture -d fixture; do n=$((n+1)); [ "$n" -lt 30 ] || exit 1; sleep 1; done',
  )
  sql = postgres({
    host: '127.0.0.1',
    port: options.ports[0],
    database: 'fixture',
    username: 'fixture',
    connect_timeout: 3,
    max: 1,
  })
  await runMigrations(sql, await loadMigrationCatalog(), { kind: 'up' })
  await sql.end()
  sql = undefined
  const layer = join(root, 'layer'),
    helper = join(checkout, 'tests/helpers/kobralink-rtc/https.ts')
  const env = {
    ...Object.fromEntries(
      [
        'PATH',
        'HOME',
        'USER',
        'LANG',
        'LC_ALL',
        'TZ',
        'PLAYWRIGHT_BROWSERS_PATH',
        'XDG_CACHE_HOME',
        'TMPDIR',
      ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
    ),
    KOBRALINK_RTC_KOBRA_PORT: String(options.ports[2]),
    PNPM_CONFIG_ALLOW_BUILDS: '{"esbuild":false}',
    BROWSERSLIST: 'defaults',
    KOBRALINK_RTC_RUN_DIRECTORY: root,
    SIGNALLING_HTTPS_DISPOSABLE: 'yes',
    SIGNALLING_HTTPS_RTC_FIXTURE: 'yes',
    SIGNALLING_HTTPS_PORT: String(options.ports[0]),
    SIGNALLING_HTTPS_LAYER: layer,
    SIGNALLING_HTTPS_LEDGER: join(root, 'https.ledger'),
    SIGNALLING_HTTPS_FARM_PAGE: 'yes',
  }
  await run(
    'prepare-layer',
    process.execPath,
    [helper, '--prepare-layer', layer],
    env,
    120000,
  )
  await run(
    'prepare-app',
    join(checkout, 'apps/farm/node_modules/.bin/nuxt'),
    ['prepare'],
    env,
    300000,
    join(checkout, 'apps/farm'),
  )
  await run(
    'build-layer',
    join(layer, 'node_modules/.bin/nuxt'),
    ['build'],
    env,
    900000,
    layer,
  )
  await run(
    'seal-layer',
    process.execPath,
    [helper, '--seal-build', layer],
    env,
    120000,
  )
  await cp(
    join(layer, 'fixture-build-receipt.json'),
    join(root, 'source-and-build-receipt.json'),
  )
  await run('registration', process.execPath, [helper, '--run'], env, 300000)
  await ledger({ positiveChain: 'pass' })
} finally {
  stop()
  await sql?.end({ timeout: 3 })
  for (const n of containers.reverse()) {
    const present = docker('ps', '-aq', '--filter', `name=^/${n}$`).trim()
    if (!present) continue
    assert.equal(
      docker(
        'inspect',
        '--format',
        '{{index .Config.Labels "org.openfarm.rtc"}}',
        n,
      ).trim(),
      id,
    )
    await writeFile(
      join(
        root,
        n.endsWith('-db')
          ? 'postgres.log'
          : n.endsWith('-bridge')
            ? 'kobralink.log'
            : 'synthetic.log',
      ),
      (() => {
        const r = spawnSync('docker', ['--context', context, 'logs', n], {
          encoding: 'utf8',
          timeout: 15000,
        })
        return r.stdout + r.stderr
      })(),
      { mode: 0o600 },
    )
    docker('rm', '-v', '-f', n)
    await ledger({ removed: n })
  }
  if (network) {
    docker('network', 'rm', name)
    await ledger({ removed: name })
  }
  for (const entry of [
    'identity',
    'credential.json',
    'provisioning.json',
    'state',
    'runtime.json',
    'synthetic',
    'layer',
  ])
    await rm(join(root, entry), { recursive: true, force: true })
  execFileSync('limactl', ['stop', 'colima-openfarm-kobralink-togiej'], {
    env: {
      ...process.env,
      LIMA_HOME: join(process.env.HOME ?? '', '.colima/_lima'),
    },
    timeout: 60000,
  })
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  await ledger({
    custody: 'STOPPED',
    globalContext: execFileSync('docker', ['context', 'show'], {
      encoding: 'utf8',
    }).trim(),
  })
  console.log(JSON.stringify({ evidence: root }))
}
