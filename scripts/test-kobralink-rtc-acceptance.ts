import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  appendFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'
import postgres from 'postgres'
import { registrationAdmission } from '../tests/helpers/kobralink-rtc/admission.ts'
import {
  aggregate,
  reportSections,
  selectWorlds,
  verifyReport,
  WORLDS,
  type CheckRecord,
  type World,
} from '../tests/helpers/kobralink-rtc/qualification.ts'
import { loadMigrationCatalog, runMigrations } from './db/migrations.ts'
import { createSyntheticTls } from '../tests/fixtures/kobralink-integration/tls.ts'

const checkout = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
if (process.argv[2] === '--verify-report') {
  // Reads a committed report only: no Docker, sockets, database or browser.
  const path =
    process.argv[3] ??
    join(checkout, 'docs/compatibility/kobralink-rtc-acceptance.json')
  const problems = verifyReport(JSON.parse(await readFile(path, 'utf8')))
  for (const problem of problems) console.error(problem)
  console.log(JSON.stringify({ verified: problems.length === 0 }))
  process.exit(problems.length ? 1 : 0)
}
const options = registrationAdmission(process.env, checkout)
assert.equal(process.argv.length, 2)
const worlds = selectWorlds(process.env.KOBRALINK_RTC_WORLDS)
const id = randomUUID()
const name = 'o3dfm-kobra-rtc-' + id
const root = join(options.evidence, id)
await mkdir(root, { mode: 0o700, recursive: true })
const ledger = async (event: object) => {
  await appendFile(
    join(root, 'resources.jsonl'),
    JSON.stringify(event) + '\n',
    {
      mode: 0o600,
    },
  )
}
const context = 'colima-openfarm-kobralink-togiej'
const instance = 'colima-openfarm-kobralink-togiej'
const lima = {
  ...process.env,
  LIMA_HOME: join(process.env.HOME ?? '', '.colima/_lima'),
}
const docker = (...args: string[]) =>
  execFileSync('docker', ['--context', context, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  })
const children = new Set<ReturnType<typeof spawn>>()
/** Runs one owned child to completion and returns its exit code. */
async function step(
  directory: string,
  label: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  cwd = checkout,
): Promise<number | null> {
  const output = createWriteStream(join(directory, label + '.log'), {
    mode: 0o600,
  })
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  await ledger({ process: label, pid: child.pid })
  child.stdout?.pipe(output, { end: false })
  child.stderr?.pipe(output, { end: false })
  const signal = (value: NodeJS.Signals) => {
    if (child.pid)
      try {
        process.kill(-child.pid, value)
      } catch {
        /* Already exited. */
      }
  }
  const timer = setTimeout(() => signal('SIGTERM'), timeout)
  const kill = setTimeout(() => signal('SIGKILL'), timeout + 5000)
  try {
    const [code] = await once(child, 'close')
    return typeof code === 'number' ? code : null
  } finally {
    clearTimeout(timer)
    clearTimeout(kill)
    children.delete(child)
    await new Promise<void>((resolve) => output.end(resolve))
  }
}
async function run(...input: Parameters<typeof step>) {
  assert.equal(await step(...input), 0, `${input[1]} failed; read private log`)
}
const containers: string[] = []
let network = false
let sql: ReturnType<typeof postgres> | undefined
const stop = () => {
  for (const child of children)
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* Already exited. */
      }
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
const PRIVATE_ENTRIES = [
  'identity',
  'credential.json',
  'provisioning.json',
  'state',
  'runtime.json',
  'harness-private.json',
]
const records: CheckRecord[] = []
const cleanup = async (checkId: string, ok: boolean, detail: string) => {
  const record: CheckRecord = {
    world: 'runner',
    qualification: 'resource_cleanup',
    id: checkId,
    ok,
    detail,
  }
  records.push(record)
  await appendFile(
    join(root, 'runner-checks.jsonl'),
    JSON.stringify(record) + '\n',
    { mode: 0o600 },
  )
}
const worldResults: Record<string, { exit: number | null; checks: number }> = {}
let head = ''

async function removeContainer(n: string, directory: string) {
  const present = docker('ps', '-aq', '--filter', `name=^/${n}$`).trim()
  if (!present) return
  assert.equal(
    docker(
      'inspect',
      '--format',
      '{{index .Config.Labels "org.openfarm.rtc"}}',
      n,
    ).trim(),
    id,
  )
  const logs = spawnSync('docker', ['--context', context, 'logs', n], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
  })
  // Bounded: the tail is what explains an outcome.
  await writeFile(
    join(
      directory,
      n.endsWith('-db')
        ? 'postgres.log'
        : n.endsWith('-bridge')
          ? 'kobralink.log'
          : 'synthetic.log',
    ),
    ((logs.stdout ?? '') + (logs.stderr ?? '')).slice(-262_144),
    { mode: 0o600 },
  )
  docker('rm', '-v', '-f', n)
  await ledger({ removed: n })
}

try {
  const free = await statfs(checkout, { bigint: true })
  assert.ok(free.bavail * free.bsize > 10n * 1024n ** 3n)
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
    '',
    'Sealed source must be committed',
  )
  head = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  await ledger({
    head,
    worlds,
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
        instance,
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
      { env: lima, timeout: 15000 },
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
    SIGNALLING_HTTPS_DISPOSABLE: 'yes',
    SIGNALLING_HTTPS_RTC_FIXTURE: 'yes',
    SIGNALLING_HTTPS_PORT: String(options.ports[0]),
    SIGNALLING_HTTPS_LAYER: layer,
    SIGNALLING_HTTPS_FARM_PAGE: 'yes',
    KOBRALINK_RTC_WORLD: WORLDS[0],
  }
  // One sealed build of the candidate serves every world.
  await run(
    root,
    'prepare-layer',
    process.execPath,
    [helper, '--prepare-layer', layer],
    env,
    120000,
  )
  await run(
    root,
    'prepare-app',
    join(checkout, 'apps/farm/node_modules/.bin/nuxt'),
    ['prepare'],
    env,
    300000,
    join(checkout, 'apps/farm'),
  )
  await run(
    root,
    'build-layer',
    join(layer, 'node_modules/.bin/nuxt'),
    ['build'],
    env,
    900000,
    layer,
  )
  await run(
    root,
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

  /** A fresh database, bridge and printer; nothing carries over between worlds. */
  async function world(current: World) {
    const directory = join(root, current)
    await mkdir(directory, { mode: 0o700 })
    const owned: string[] = []
    try {
      const printer = await create(current + '-printer', [
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
      owned.push(printer)
      docker('cp', synthetic + '/.', printer + ':/fixture')
      docker('start', printer)
      docker(
        'exec',
        printer,
        'bun',
        '-e',
        `let ok=false;for(let n=0;n<30;n++){try{ok=(await fetch('http://127.0.0.1:18910/info')).ok;if(ok)break}catch{}await Bun.sleep(100)}if(!ok)process.exit(1)`,
      )
      // The printer's own MQTT password, read the way a LAN client discovers
      // it. Kept in memory and one private file so the browser can be searched
      // for it; removed with the rest of the private material.
      const printerPassword = docker(
        'exec',
        printer,
        'bun',
        '-e',
        `const{createDecipheriv}=await import('node:crypto');const i=await(await fetch('http://127.0.0.1:18910/info')).json();const r=await(await fetch('http://127.0.0.1:18910/ctrl?ts='+String(Date.now()).padStart(13,'0')+'&nonce=abc123&sign='+'a'.repeat(32)+'&did=random',{method:'POST'})).json();const d=createDecipheriv('aes-128-cbc',Buffer.from(i.token.slice(16)),Buffer.from(r.data.token));console.log(JSON.parse(Buffer.concat([d.update(Buffer.from(r.data.info,'base64')),d.final()]).toString()).password)`,
      ).trim()
      assert.match(printerPassword, /^[a-f0-9]{48}$/)
      const bridgeSecret = randomBytes(32).toString('hex')
      const bridge = await create(current + '-bridge', [
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
        `BETTER_AUTH_SECRET=${bridgeSecret}`,
        '-e',
        `BETTER_AUTH_URL=http://127.0.0.1:${options.ports[2]}`,
        options.kobraImage,
      ])
      owned.push(bridge)
      docker('start', bridge)
      const db = await create(current + '-db', [
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
      owned.push(db)
      docker('start', db)
      docker(
        'exec',
        db,
        'sh',
        '-c',
        'n=0; until pg_isready -U fixture -d fixture && psql -U fixture -d fixture -c "SELECT 1" >/dev/null 2>&1; do n=$((n+1)); [ "$n" -lt 30 ] || exit 1; sleep 1; done',
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
      await writeFile(
        join(directory, 'harness-private.json'),
        JSON.stringify({
          bridgeSecret,
          printerPassword,
          bridgeContainer: bridge,
          printerContainer: printer,
        }),
        { mode: 0o600, flag: 'wx' },
      )
      return await step(
        directory,
        'registration',
        process.execPath,
        [helper, '--run'],
        {
          ...env,
          KOBRALINK_RTC_WORLD: current,
          KOBRALINK_RTC_RUN_DIRECTORY: directory,
          SIGNALLING_HTTPS_LEDGER: join(directory, 'https.ledger'),
        },
        480000,
      )
    } finally {
      await sql?.end({ timeout: 3 })
      sql = undefined
      for (const n of owned.reverse()) await removeContainer(n, directory)
      for (const entry of PRIVATE_ENTRIES)
        await rm(join(directory, entry), { recursive: true, force: true })
    }
  }
  for (const current of worlds) {
    let exit: number | null = null
    try {
      exit = await world(current)
    } catch (error) {
      await ledger({
        world: current,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      })
    }
    let checks = 0
    try {
      const lines = (
        await readFile(join(root, current, 'checks.jsonl'), 'utf8')
      )
        .split('\n')
        .filter(Boolean)
      for (const line of lines) records.push(JSON.parse(line) as CheckRecord)
      checks = lines.length
    } catch {
      /* A world that never reached its first check contributes nothing. */
    }
    worldResults[current] = { exit, checks }
    await ledger({ world: current, exit, checks })
  }
} finally {
  stop()
  await sql?.end({ timeout: 3 })
  for (const n of [...containers].reverse())
    await removeContainer(n, root).catch(() => {})
  if (network) {
    try {
      docker('network', 'rm', name)
      await ledger({ removed: name })
    } catch {
      /* Reported by the audit below. */
    }
  }
  for (const entry of ['synthetic', 'layer'])
    await rm(join(root, entry), { recursive: true, force: true })
  // Audit while the owned VM still answers, then return it stopped.
  const audit = (what: 'ps' | 'network') => {
    try {
      return what === 'ps'
        ? docker('ps', '-aq', '--filter', `label=org.openfarm.rtc=${id}`).trim()
        : docker(
            'network',
            'ls',
            '-q',
            '--filter',
            `label=org.openfarm.rtc=${id}`,
          ).trim()
    } catch {
      return 'audit-unavailable'
    }
  }
  const leftContainers = audit('ps')
  const leftNetworks = audit('network')
  await cleanup(
    'containers-removed',
    leftContainers === '',
    `labelled containers left: ${leftContainers ? leftContainers.split('\n').length : 0}; created: ${containers.length}`,
  )
  await cleanup(
    'network-removed',
    leftNetworks === '',
    `labelled networks left: ${leftNetworks ? leftNetworks.split('\n').length : 0}`,
  )
  const leftovers: string[] = []
  for (const directory of [root, ...WORLDS.map((w) => join(root, w))])
    for (const entry of [...PRIVATE_ENTRIES, 'synthetic', 'layer'])
      if (await stat(join(directory, entry)).catch(() => null))
        leftovers.push(entry)
  await cleanup(
    'private-material-removed',
    leftovers.length === 0,
    `credentials, TLS keys, identities, state and build layer left: ${leftovers.length}`,
  )
  let vm = 'unknown'
  try {
    execFileSync('limactl', ['stop', instance], { env: lima, timeout: 60000 })
  } catch {
    /* Status below is authoritative. */
  }
  try {
    vm =
      execFileSync('limactl', ['list', '--format', '{{.Name}} {{.Status}}'], {
        env: lima,
        encoding: 'utf8',
        timeout: 15000,
      })
        .split('\n')
        .find((line) => line.startsWith(instance + ' '))
        ?.split(' ')[1] ?? 'unknown'
  } catch {
    vm = 'unknown'
  }
  await cleanup('vm-stopped', vm === 'Stopped', `owned VM status: ${vm}`)
  const globalContext = execFileSync('docker', ['context', 'show'], {
    encoding: 'utf8',
  }).trim()
  await cleanup(
    'global-context-preserved',
    globalContext === 'orbstack',
    `global context: ${globalContext}`,
  )
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  await ledger({ custody: vm === 'Stopped' ? 'STOPPED' : vm, globalContext })

  const complete = worlds.length === WORLDS.length
  const summary = aggregate(records)
  const status = complete ? summary.status : 'fail'
  const receipt = await readFile(
    join(root, 'source-and-build-receipt.json'),
    'utf8',
  )
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch((): Record<string, unknown> => ({}))
  const report = {
    status,
    complete,
    head,
    run: id,
    sourceSha256: receipt.sourceSha256 ?? null,
    outputSha256: receipt.outputSha256 ?? null,
    worlds: worldResults,
    ...reportSections(summary.results),
    failures: summary.failures,
    missing: summary.missing,
    checks: records.length,
  }
  await writeFile(
    join(root, 'final-report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  )
  // Hashes of every retained file, so a later reader can prove custody.
  const hashes: string[] = []
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path, relative)
      else if (entry.isFile() && entry.name !== 'evidence.sha256')
        hashes.push(
          `${createHash('sha256')
            .update(await readFile(path))
            .digest('hex')}  ${relative}`,
        )
    }
  }
  await walk(root, '')
  await writeFile(
    join(root, 'evidence.sha256'),
    hashes.sort().join('\n') + '\n',
    {
      mode: 0o600,
    },
  )
  console.log(JSON.stringify({ evidence: root, status, complete }))
  if (status !== 'pass') process.exitCode = 1
}
