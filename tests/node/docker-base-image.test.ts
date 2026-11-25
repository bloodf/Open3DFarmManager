// SPDX-License-Identifier: MIT
// Docker is never called here: argv builders and lifecycles run against fakes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
// Loosely typed: the modules under test are plain .mjs scripts.
const load = async (path: string): Promise<any> =>
  import(new URL(`../../${path}`, import.meta.url).href)

const image = await load('scripts/docker-base-image.mjs')
const lib = await load('scripts/docker-run-lib.mjs')
const polish = await load('tests/e2e/polish-runner-lib/docker.mjs')
const checkAll = await load('scripts/check-all-docker.mjs')
const queueClock = await load('scripts/test-queue-clock-docker.mjs')
const bambu = await load('tests/node/run-bambu-gate.mjs')
const upstream = await load('tests/contract/spoolman-parity/upstream.mjs')

const DAY = 24 * 60 * 60 * 1000

test('the tag hashes the lockfile and the Node image reference', () => {
  const expected = createHash('sha256')
    .update('lock')
    .update('\0')
    .update('node:22')
    .digest('hex')
    .slice(0, 12)
  assert.equal(
    image.baseImageTag('lock', 'node:22'),
    `openfarm-test-base:${expected}`,
  )
  assert.notEqual(
    image.baseImageTag('lock2', 'node:22'),
    image.baseImageTag('lock', 'node:22'),
  )
  assert.notEqual(
    image.baseImageTag('lock', 'node:23'),
    image.baseImageTag('lock', 'node:22'),
  )
  assert.equal(
    image.baseImageTag('lock', 'local-node'),
    image.baseImageTag('lock', 'local-node:latest'),
  )
  assert.equal(
    image.projectImageTag(repo, 'node:22'),
    image.baseImageTag(
      readFileSync(join(repo, 'package-lock.json')),
      'node:22',
    ),
  )
})

test('the image is built only when missing, from manifests alone', (t) => {
  // The build context is a run directory: keep it out of the real cache.
  const cache = mkdtempSync(join(tmpdir(), 'openfarm-base-context-test-'))
  const previous = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = cache
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previous
    rmSync(cache, { recursive: true, force: true })
  })
  const calls: string[][] = []
  let context: string[] = []
  const docker = (present: (ref: string) => boolean) => (args: string[]) => {
    calls.push(args)
    if (args[0] === 'build') context = readdirSync(args.at(-1)!)
    if (args[0] !== 'image') return { status: 0 }
    return { status: present(args.at(-1)!) ? 0 : 1 }
  }
  const reused = image.ensureBaseImage({
    nodeImage: 'node:22',
    docker: docker(() => true),
  })
  assert.equal(reused, image.projectImageTag(repo, 'node:22'))
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['image'],
  )

  calls.length = 0
  image.ensureBaseImage({
    nodeImage: 'node:22',
    docker: docker((ref) => ref === 'node:22'),
  })
  const build = calls.find((call) => call[0] === 'build')!
  assert.ok(build.includes('NODE_IMAGE=node:22'))
  assert.ok(build.includes(reused))
  assert.ok(context.includes('package-lock.json'))
  assert.ok(!context.includes('scripts') && !context.includes('node_modules'))
  assert.ok(!existsSync(build.at(-1)!), 'build context is removed')

  assert.throws(
    () =>
      image.ensureBaseImage({
        nodeImage: 'node:22',
        docker: docker(() => false),
      }),
    /not present locally/,
  )
  assert.match(
    readFileSync(join(repo, 'infra/test-base/Dockerfile'), 'utf8'),
    /RUN npm ci /,
  )
})

test('the seed copies every node_modules tree and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'openfarm-seed-test-'))
  try {
    const deps = join(root, 'deps')
    const work = join(root, 'work')
    for (const dir of [
      'deps/node_modules/@x',
      'deps/apps/farm/node_modules/a',
      'deps/packages/p',
      'work/apps/farm',
      'work/packages/p',
    ])
      mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(deps, 'package.json'), 'from the image')
    writeFileSync(join(deps, 'apps/farm/node_modules/a/index.js'), 'nested')
    writeFileSync(join(work, 'packages/p/index.js'), 'source')
    symlinkSync('../../packages/p', join(deps, 'node_modules/@x/p'))
    const script = image.seedNodeModules(work).replace(image.DEPS_DIR, deps)
    const result = spawnSync('sh', ['-ec', script], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      readFileSync(join(work, 'apps/farm/node_modules/a/index.js'), 'utf8'),
      'nested',
    )
    // Workspace links resolve to the run's own sources, not the image's.
    assert.equal(
      readFileSync(join(work, 'node_modules/@x/p/index.js'), 'utf8'),
      'source',
    )
    assert.ok(!existsSync(join(work, 'package.json')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prune selects only old, non-current tags of its own repository', () => {
  const now = Date.parse('2026-11-25T00:00:00Z')
  const aged = (days: number) => new Date(now - days * DAY).toISOString()
  const entry = (repository: string, tag: string, created: string) => ({
    repository,
    tag,
    created,
  })
  const images = [
    entry('openfarm-test-base', 'old', aged(8)),
    entry('openfarm-test-base', 'current', aged(90)),
    entry('openfarm-test-base', 'young', aged(6)),
    entry('openfarm-test-base', 'week', aged(7)),
    entry('openfarm-test-base', '<none>', aged(30)),
    entry('openfarm-test-base', 'unknown-age', 'not a date'),
    entry('node', 'old', aged(30)),
    entry('openfarm-e2e-node22.23.5', 'latest', aged(30)),
    entry('openfarm-test-base-other', 'old', aged(30)),
    entry('registry.example/openfarm-test-base', 'old', aged(30)),
  ]
  const keep = new Set(['openfarm-test-base:current'])
  assert.deepEqual(image.selectPrunable(images, { now, keep }), [
    'openfarm-test-base:old',
  ])

  const calls: string[][] = []
  const removed = image.pruneBaseImages({
    now,
    keep,
    docker: (args: string[]) => {
      calls.push(args)
      if (args[1] === 'ls')
        return {
          status: 0,
          stdout:
            'openfarm-test-base old\nopenfarm-test-base current\nnode old\n',
        }
      return { status: 0, stdout: aged(10) }
    },
  })
  assert.deepEqual(removed, ['openfarm-test-base:old'])
  assert.deepEqual(
    calls.filter((call) => call[1] === 'rm'),
    [['image', 'rm', 'openfarm-test-base:old']],
  )
  assert.ok(!calls.some((call) => call.includes('node:old')))
  assert.ok(
    image
      .currentTags(repo, {})
      .has(image.projectImageTag(repo, image.browserNodeImage(repo))),
  )
})

test('every runner builds --rm argv with run-directory mounts and no install', () => {
  const runDir = join(lib.runRoot(), 'argv-test')
  const names = checkAll.resourceNames('argv-test')
  const tree = join(runDir, 'work')
  const seed = image.seedNodeModules('/work')
  const argv: [string, string[], string][] = [
    [
      'spools/printer',
      polish.screenEvidenceArgs({
        name: 'n',
        image: 'i',
        runDir,
        script: seed,
      }),
      runDir,
    ],
    [
      'polish build',
      polish.treeRunArgs({
        name: 'n',
        image: 'i',
        tree,
        command: ['sh', '-ec', seed],
      }),
      runDir,
    ],
    [
      'polish app',
      polish.polishAppArgs({ name: 'n', image: 'i', output: tree }),
      runDir,
    ],
    [
      'polish playwright',
      polish.polishPlaywrightArgs({
        name: 'n',
        image: 'i',
        app: 'a',
        nodeBin: join(runDir, 'node22'),
        tree,
        evidence: join(runDir, 'evidence'),
        script: 'true',
      }),
      runDir,
    ],
    [
      'polish node',
      polish.nodeExtractorArgs({ name: 'n', image: 'i' }),
      runDir,
    ],
    [
      'farm app',
      polish.farmAppArgs({
        name: 'n',
        image: 'i',
        network: 'internal',
        output: tree,
      }),
      runDir,
    ],
    [
      'farm proxy',
      polish.farmProxyArgs({ name: 'n', image: 'i', upstream: 'a' }),
      runDir,
    ],
    [
      'queue clock',
      queueClock.queueClockRunArgs({
        name: 'n',
        cpus: 2,
        runDir,
        image: 'i',
      }),
      runDir,
    ],
    [
      'queue clock on disk',
      queueClock.queueClockRunArgs({
        name: 'n',
        cpus: 2,
        runDir,
        tmpDir: join(runDir, 'tmp'),
        image: 'i',
      }),
      runDir,
    ],
    [
      'queue clock seed',
      queueClock.queueClockSeedArgs({ runDir, image: 'i' }),
      runDir,
    ],
    ['bambu probe', bambu.bambuProbeArgs('i'), runDir],
    [
      'bambu seed',
      bambu.bambuSeedArgs({ image: 'i', directory: tree, label: 'l' }),
      runDir,
    ],
    [
      'bambu test',
      bambu.bambuTestArgs({
        image: 'i',
        directory: tree,
        label: 'l',
        testArgs: ['node', '--test'],
      }),
      runDir,
    ],
    [
      'check image',
      lib.checkImageRunArgs({ name: 'n', image: 'i', command: ['true'] }),
      runDir,
    ],
    [
      'spoolman upstream',
      upstream.upstreamCreateArgs({ name: 'n', image: 'i', fixtureDir: tree }),
      runDir,
    ],
    ['run dir purge', lib.purgeArgs(runDir, 'i'), runDir],
    [
      'check-all',
      checkAll.createArgs(checkAll.resolveConfig({}), names),
      names.runDir,
    ],
  ]
  for (const [label, args, owned] of argv) {
    assert.deepEqual(lib.findRunArgvProblems(args, owned), [], label)
    assert.ok(args.includes('--rm'), label)
    assert.doesNotMatch(args.join(' '), /\bnpm (ci|install)\b/, label)
  }
  const gate = checkAll.planCalls(checkAll.resolveConfig({}), names)
  assert.doesNotMatch(gate.flat().join(' '), /\bnpm (ci|install)\b/)
  // Offline runners stay offline; only the farm proxy publishes a port.
  for (const [label, args] of argv.filter(([label]) =>
    /^(spools|polish build|polish app|queue|bambu|check|run dir)/.test(label),
  ))
    assert.match(args.join(' '), /--network[ =]none/, label)
  assert.deepEqual(
    argv.filter(([, args]) => args.includes('-p')).map(([label]) => label),
    ['farm proxy', 'spoolman upstream'],
  )
})

test('the argv check rejects what the rules forbid', () => {
  const runDir = '/cache/openfarm-docker/x'
  for (const bad of [
    ['run', 'i'],
    ['run', '--rm', '-v', '/home/me:/work', 'i'],
    ['run', '--rm', '-v', 'npm-cache:/npm-cache', 'i'],
    ['run', '--rm', '-v', `${runDir}/../y:/work`, 'i'],
    ['run', '--rm', '-v', `${runDir}-other:/work`, 'i'],
    ['run', '--rm', '--mount', 'type=volume,destination=/tmp', 'i'],
    ['run', '--rm', '--mount', 'type=image,source=a,destination=/a', 'i'],
    ['run', '--rm', '--mount', 'type=bind,source=/etc,destination=/e', 'i'],
    ['run', '--rm', '--network', 'host', 'i'],
    ['run', '--rm', 'i', 'sh', '-c', 'npm ci --offline'],
  ])
    assert.notDeepEqual(lib.findRunArgvProblems(bad, runDir), [], bad.join(' '))
})

test('no switched runner source installs dependencies', () => {
  for (const file of [
    'tests/e2e/polish-runner-lib/docker.mjs',
    'tests/e2e/run-polish-docker.mjs',
    'tests/e2e/run-spools-docker.mjs',
    'tests/e2e/run-printer-docker.mjs',
    'tests/e2e/run-jobs-docker.mjs',
    'scripts/test-queue-clock-docker.mjs',
    'tests/node/run-bambu-gate.mjs',
  ])
    assert.doesNotMatch(
      readFileSync(join(repo, file), 'utf8'),
      /npm ci --|'ci',/,
      file,
    )
})

/** Fake Docker CLI whose `create` stays in flight until released. */
function heldDocker() {
  const calls: string[][] = []
  const options: ({ detached?: boolean } | undefined)[] = []
  let release!: () => void
  const held = new Promise<void>((done) => (release = done))
  const exec = async (args: string[], option?: { detached?: boolean }) => {
    calls.push(args)
    options.push(option)
    if (args[0] === 'create') {
      await held
      return { status: 0, stdout: 'container-id\n', stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { calls, options, exec, release }
}

test('an interruption waits for the in-flight create, then removes it', async () => {
  const fake = heldDocker()
  const lifecycle = lib.createLifecycle({ exec: fake.exec })
  const order: string[] = []
  lifecycle.finalizer(() => order.push('first registered'))
  lifecycle.finalizer(() => order.push('last registered'))
  const handlers = new Map<string, () => Promise<void>>()
  const exits: number[] = []
  lifecycle.installSignals({
    on: (signal: string, handler: () => Promise<void>) =>
      handlers.set(signal, handler),
    exit: (code: number) => exits.push(code),
  })
  const running = lifecycle.run(['run', '--rm', 'i', 'true'])
  const refused = assert.rejects(running, /Interrupted/)
  const interrupted = handlers.get('SIGTERM')!()
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(
    fake.calls.map((call) => call[0]),
    ['create'],
    'nothing is cleaned up while create is in flight',
  )
  assert.equal(fake.options[0]?.detached, true, 'Ctrl-C cannot kill the CLI')
  assert.deepEqual(exits, [])

  fake.release()
  await Promise.all([interrupted, refused])
  assert.deepEqual(fake.calls[1], ['rm', '-f', '-v', 'container-id'])
  assert.ok(!fake.calls.some((call) => call[0] === 'start'))
  assert.deepEqual(exits, [143])
  assert.deepEqual(order, ['last registered', 'first registered'])
  await assert.rejects(lifecycle.create(['create', 'i']), /Interrupted/)
})

test('a finished foreground run removes its container and keeps the status', async () => {
  const calls: string[][] = []
  const lifecycle = lib.createLifecycle({
    exec: async (args: string[]) => {
      calls.push(args)
      return {
        status: args[0] === 'start' ? 7 : 0,
        stdout: 'id\n',
        stderr: '',
      }
    },
  })
  const result = await lifecycle.run(['run', '--rm', 'i', 'false'])
  assert.equal(result.status, 7)
  assert.deepEqual(calls, [
    ['create', '--rm', 'i', 'false'],
    ['start', '--attach', 'id'],
    ['rm', '-f', '-v', 'id'],
  ])
  assert.throws(() => lib.asCreate(['run', 'i']), /--rm/)
})

test('check-all cleanup waits for the in-flight create too', async () => {
  const names = checkAll.resourceNames('interrupted')
  const calls: string[][] = []
  let release!: () => void
  const held = new Promise<void>((done) => (release = done))
  const session = checkAll.containerSession({
    names,
    docker: async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'create') await held
      const stdout = args[0] === 'inspect' ? `${names.id} cid` : ''
      return { code: 0, stdout, stderr: '' }
    },
  })
  const creating = session.create(['create', '--rm'])
  const cleaning = session.cleanup()
  await new Promise((done) => setImmediate(done))
  assert.equal(calls.length, 1)
  release()
  await creating
  assert.equal(await cleaning, false)
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['create', 'inspect', 'rm', 'ps'],
  )
  assert.throws(() => session.create(['create']), /Interrupted/)
})

test('check-all masks the PostgreSQL volume and the checker requires it', () => {
  const names = checkAll.resourceNames('pg-mask')
  const calls = checkAll.planCalls(checkAll.resolveConfig({}), names)
  const mask = '/var/lib/postgresql/data:rw,size=1m'
  const create = calls[0]
  assert.equal(create[create.indexOf(mask) - 1], '--tmpfs')
  const unmasked = calls.map((call: string[]) =>
    call.filter((arg) => arg !== mask),
  )
  assert.ok(
    checkAll
      .findPlanProblems(unmasked)
      .some((problem: string) => /PostgreSQL image volume/.test(problem)),
  )
})

test('run directories live under the cache root and only they are removed', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'openfarm-run-dir-test-'))
  try {
    const env = { XDG_CACHE_HOME: cache }
    assert.equal(lib.runRoot(env), join(cache, 'openfarm-docker'))
    assert.equal(
      lib.runRoot({ HOME: '/home/someone' }),
      '/home/someone/.cache/openfarm-docker',
    )
    const runDir = lib.createRunDir('t', env)
    writeFileSync(join(runDir, 'file'), 'x')
    await lib.removeRunDir(runDir, { env })
    assert.ok(!existsSync(runDir))
    await assert.rejects(lib.removeRunDir(cache, { env }), /Refusing/)
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
})
