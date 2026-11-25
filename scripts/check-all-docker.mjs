#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Runs the complete `npm run check:all` inside one Docker container so every
// service process (PostgreSQL clusters, simulators, Nuxt build, test servers)
// stays in Docker. The run is offline and deterministic:
//
//   * no image is pulled; the images below must already exist locally. The only
//     image ever built is the dependency image, once per lockfile (see
//     docker-base-image.mjs), before the container is created;
//   * the container has no network (loopback only), no published ports, no
//     Docker socket, no privileges and a read-only root filesystem;
//   * dependencies are copied from that image; nothing is installed or
//     downloaded inside the container;
//   * the source is a copy of the working tree (tracked + untracked, not
//     ignored), so the host tree gets no generated output and concurrent edits
//     are never touched.
//
// Image composition (all local): the PostgreSQL image is the base because the
// database suites need initdb/pg_ctl/postgres on glibc; the Node 22 image
// contributes /usr/local (node, npm) and git by read-only image mounts. The
// PostgreSQL binaries are exposed through OPENFARM_PG_BIN at /opt/pg, with
// /usr/lib/postgresql hidden, because the binary-discovery suites assert the
// "no PostgreSQL installed" error when PATH and OPENFARM_PG_BIN are empty.
// The browser suites get the Node image's Playwright Chromium through
// OPENFARM_CHROME_PATH (see check-all-docker-browser.mjs); nothing is skipped.
// python3 is the Node image's, run through a wrapper that adds the image
// libraries the Debian userland lacks (libexpat.so.1 for pyexpat), and /tmp is
// a bind mount of the run directory on the host disk so the release rehearsal
// sees its required > 10 GiB (see check-all-docker-runtime.mjs).
//
// Resource ownership and cleanup: a run owns exactly one `--rm` container
// (`openfarm-check-all-<id>`, label org.open3dfarmmanager.check-all-docker=<id>)
// and one run directory under ${XDG_CACHE_HOME:-~/.cache}/openfarm-docker/.
// Images are only mounted read-only, and the PostgreSQL image's declared volume
// is masked by a tmpfs. Cleanup waits for an in-flight create, verifies the
// label, removes the container, confirms it is gone and deletes the run
// directory; the ledger under the host tmpdir records the outcome.
//
//   node scripts/check-all-docker.mjs              # run the full gate
//   node scripts/check-all-docker.mjs --self-test  # fast, starts no service
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  statfsSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BROWSER_CACHE_DIR,
  CHROME_WRAPPER,
  PREPARE_BROWSER,
  browserMount,
  browserPlanChecks,
} from './check-all-docker-browser.mjs'
import {
  PREPARE_PYTHON,
  PREPARE_SCRATCH,
  PYTHON_BIN_DIR,
  SCRATCH_DIR,
  runtimePlanChecks,
  scratchMount,
} from './check-all-docker-runtime.mjs'
import {
  DEPS_DIR,
  browserNodeImage,
  ensureBaseImage,
  projectImageTag,
  seedNodeModules,
} from './docker-base-image.mjs'
import { removeRunDir, runRoot } from './docker-run-lib.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MIN_DOCKER_MAJOR = 28 // `--mount type=image` with image-subpath
const MIN_FREE_BYTES = 10 * 1024 ** 3
const LABEL_KEY = 'org.open3dfarmmanager.check-all-docker'
const GATE_COMMAND = ['npm', 'run', 'check:all']
const SERVICE_UID = '999:999' // `postgres` user of the PostgreSQL image; initdb refuses root
// The PostgreSQL image declares this volume; unmasked, every run allocates one.
const PG_VOLUME_MASK = '/var/lib/postgresql/data:rw,size=1m'

/**
 * Prerequisites, all of which must already exist locally. Override with the
 * OPENFARM_GATE_* variables; defaults name the images this repository's Docker
 * tasks already hold. `baseImage` is derived from the lockfile and Node image.
 */
export function resolveConfig(env = process.env) {
  const nodeImage = env.OPENFARM_GATE_NODE_IMAGE || browserNodeImage(ROOT)
  return {
    docker: env.OPENFARM_GATE_DOCKER || 'docker',
    nodeImage,
    baseImage: projectImageTag(ROOT, nodeImage),
    // PostgreSQL 17.12 (Debian trixie, arm64), untagged: referenced by image ID.
    pgImage:
      env.OPENFARM_GATE_PG_IMAGE ||
      'sha256:0d938e975177bef9f1f61f3f9dbcf2e0aa0a139568f66d3415ed8892eb97f6ac',
    cpus: env.OPENFARM_GATE_CPUS || '6',
    memory: env.OPENFARM_GATE_MEMORY || '10g',
    workSize: env.OPENFARM_GATE_WORK_SIZE || '6g',
  }
}

export function resourceNames(id) {
  return {
    id,
    container: `openfarm-check-all-${id}`,
    runDir: join(runRoot(), `check-all-${id}`),
  }
}

const CONTAINER_ENV = {
  HOME: '/tmp/home',
  PATH: `/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:${PYTHON_BIN_DIR}:/opt/gate-tools/bin`,
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  OPENFARM_PG_BIN: '/opt/pg/lib/postgresql/17/bin',
  GIT_EXEC_PATH: '/opt/gate-tools/lib/git-core',
  GIT_TEMPLATE_DIR: '/opt/gate-tools/share/git-core/templates',
  GIT_AUTHOR_NAME: 'check-all',
  GIT_AUTHOR_EMAIL: 'check-all@localhost',
  GIT_COMMITTER_NAME: 'check-all',
  GIT_COMMITTER_EMAIL: 'check-all@localhost',
  NUXT_TELEMETRY_DISABLED: '1',
  OPENFARM_CHROME_PATH: CHROME_WRAPPER,
  npm_config_offline: 'true',
  npm_config_cache: '/tmp/npm-cache',
  npm_config_logs_dir: '/tmp/npm-logs',
  npm_config_update_notifier: 'false',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
}

/** `docker create` argv for the single task-owned runner container. */
export function createArgs(cfg, names) {
  return [
    'create',
    '--rm',
    ...['--pull', 'never', '--name', names.container],
    ...['--label', `${LABEL_KEY}=${names.id}`],
    ...['--network', 'none', '--init'],
    ...['--read-only', '--cap-drop', 'ALL'],
    ...['--security-opt', 'no-new-privileges'],
    ...['--cpus', cfg.cpus, '--memory', cfg.memory, '--pids-limit', '4096'],
    ...['--user', SERVICE_UID, '--workdir', '/work'],
    ...[
      '--tmpfs',
      `/work:rw,exec,uid=999,gid=999,mode=0755,size=${cfg.workSize}`,
    ],
    ...['--mount', scratchMount(names.runDir)],
    ...['--tmpfs', '/usr/lib/postgresql:ro,size=1m'],
    ...['--tmpfs', PG_VOLUME_MASK],
    ...[
      '--mount',
      `type=image,source=${cfg.nodeImage},destination=/usr/local,image-subpath=usr/local,readonly`,
    ],
    ...[
      '--mount',
      `type=image,source=${cfg.nodeImage},destination=/opt/gate-tools,image-subpath=usr,readonly`,
    ],
    ...[
      '--mount',
      `type=image,source=${cfg.pgImage},destination=/opt/pg,image-subpath=usr,readonly`,
    ],
    ...['--mount', browserMount(cfg.nodeImage)],
    ...[
      '--mount',
      `type=image,source=${cfg.baseImage},destination=${DEPS_DIR},image-subpath=${DEPS_DIR.slice(1)},readonly`,
    ],
    ...['--entrypoint', 'sleep', cfg.pgImage, 'infinity'],
  ]
}

function execBase(names, { stdin = false } = {}) {
  const env = Object.entries(CONTAINER_ENV).flatMap(([k, v]) => [
    '-e',
    `${k}=${v}`,
  ])
  return [
    'exec',
    ...(stdin ? ['-i'] : []),
    '--user',
    SERVICE_UID,
    '--workdir',
    '/work',
    ...env,
    names.container,
  ]
}

const NODE_CHECK =
  "const [a,b,c]=process.versions.node.split('.').map(Number);" +
  "if(a!==22||b<22||(b===22&&c<3)){console.error('Node '+process.versions.node+' does not satisfy ^22.22.3');process.exit(1)}"

const PG_CHECK =
  'v=$("$OPENFARM_PG_BIN/postgres" --version) || exit 1; echo "$v"; ' +
  'm=$(echo "$v" | sed -E \'s/[^0-9]*([0-9]+).*/\\1/\'); [ "$m" -ge 17 ] || { echo "PostgreSQL >= 17 required" >&2; exit 1; }'

/** Ordered phases run with `docker exec` inside the container. */
export function execPlan(names) {
  const sh = (script, opts) => [...execBase(names, opts), 'sh', '-c', script]
  return [
    {
      label: 'runtime versions',
      args: [...execBase(names), 'node', '-e', NODE_CHECK],
    },
    { label: 'postgres version', args: sh(PG_CHECK) },
    { label: 'check scratch space', args: sh(PREPARE_SCRATCH) },
    { label: 'prepare home', args: sh('mkdir -p "$HOME" /tmp/npm-logs') },
    { label: 'prepare offline browser', args: sh(PREPARE_BROWSER) },
    { label: 'prepare python runtime', args: sh(PREPARE_PYTHON) },
    {
      label: 'copy source',
      args: sh('tar -x --warning=no-unknown-keyword -f -', { stdin: true }),
      stdin: 'workspace',
    },
    {
      label: 'init git baseline',
      args: sh(
        'git init -q && git add -A && git commit -q --no-gpg-sign -m "check-all baseline"',
      ),
    },
    {
      label: 'seed locked dependencies',
      args: sh(`set -e\n${seedNodeModules('/work')}`),
    },
    {
      label: 'npm run check:all',
      args: [...execBase(names), ...GATE_COMMAND],
      gate: true,
    },
  ]
}

/** Every docker invocation this script makes, as argv arrays. */
export function planCalls(cfg, names) {
  return [createArgs(cfg, names), ...execPlan(names).map((step) => step.args)]
}

/** Invariants every docker invocation must satisfy; returns the violations. */
export function findPlanProblems(calls) {
  const problems = []
  const forbiddenSubcommands =
    /^(pull|build|buildx|compose|run|commit|push|login|network|volume|cp)$/
  const forbiddenFlags = [
    /^--privileged$/,
    /^(--publish|--publish-all|-p)$/,
    /docker\.sock/,
    /^--network=(?!none$)/,
    /^--pull=(?!never$)/,
    /^--cap-add/,
    /^(--pid|--ipc|--userns|--device)(=|$)/,
    /^(-v|--volume|--volumes-from)(=|$)/,
  ]
  for (const call of calls) {
    if (forbiddenSubcommands.test(call[0]))
      problems.push(`forbidden docker subcommand: ${call[0]}`)
    for (const arg of call.slice(1)) {
      if (forbiddenFlags.some((rule) => rule.test(String(arg))))
        problems.push(`forbidden argument: ${arg}`)
    }
  }
  const create = calls.find((call) => call[0] === 'create') ?? []
  const flagValue = (flag) => create[create.indexOf(flag) + 1]
  const requireThat = (ok, message) => ok || problems.push(message)
  requireThat(flagValue('--pull') === 'never', 'create must use --pull never')
  requireThat(
    flagValue('--network') === 'none',
    'create must use --network none',
  )
  requireThat(
    create.includes('--read-only'),
    'create must use a read-only root filesystem',
  )
  requireThat(
    flagValue('--cap-drop') === 'ALL',
    'create must drop all capabilities',
  )
  requireThat(
    flagValue('--security-opt') === 'no-new-privileges',
    'create must set no-new-privileges',
  )
  requireThat(
    flagValue('--user') === SERVICE_UID,
    'create must not run as root',
  )
  requireThat(create.includes('--rm'), 'create must use --rm')
  requireThat(
    create.some(
      (arg, i) => create[i - 1] === '--tmpfs' && arg === PG_VOLUME_MASK,
    ),
    'the PostgreSQL image volume must be masked with a tmpfs',
  )
  const mounts = create.filter((arg, i) => create[i - 1] === '--mount')
  const runDir = resourceNames(
    String(flagValue('--name')).replace('openfarm-check-all-', ''),
  ).runDir
  const scratch = mounts.filter((m) =>
    m.split(',').includes(`destination=${SCRATCH_DIR}`),
  )
  requireThat(
    scratch.length === 1 && scratch[0] === scratchMount(runDir),
    'scratch /tmp must be exactly one bind of the run directory',
  )
  const shared = mounts.filter((m) => !scratch.includes(m))
  requireThat(
    shared.length === 5 &&
      shared.every(
        (m) => m.startsWith('type=image,') && m.endsWith(',readonly'),
      ),
    'image mounts must all be read-only',
  )
  const path = CONTAINER_ENV.PATH.split(':')
  requireThat(
    calls.some((call) => call.at(-1) === PREPARE_PYTHON) &&
      path.includes(PYTHON_BIN_DIR) &&
      path.indexOf(PYTHON_BIN_DIR) < path.indexOf('/opt/gate-tools/bin'),
    'python3 must run through the prepared wrapper',
  )
  requireThat(
    calls.some((call) => call.at(-1) === PREPARE_SCRATCH),
    'scratch free space must be checked before the gate',
  )
  const gate = calls.find((call) => call.at(-1) === 'check:all')
  requireThat(
    gate?.slice(-3).join(' ') === 'npm run check:all',
    'gate must run the unmodified `npm run check:all`',
  )
  requireThat(
    mounts.some((m) => m.includes(`destination=${DEPS_DIR},`)) &&
      calls.some((call) => call.at(-1)?.includes(seedNodeModules('/work'))) &&
      !calls.some((call) => /\bnpm (ci|install|i)\b/.test(call.join(' '))),
    'dependencies must come from the base image, never from an install',
  )
  requireThat(
    mounts.some((m) =>
      m.includes(
        `destination=${BROWSER_CACHE_DIR},image-subpath=ms-playwright,`,
      ),
    ) &&
      CONTAINER_ENV.OPENFARM_CHROME_PATH === CHROME_WRAPPER &&
      calls.some((call) => call.at(-1) === PREPARE_BROWSER),
    'browser suites must get the local Chromium via OPENFARM_CHROME_PATH',
  )
  requireThat(
    CONTAINER_ENV.npm_config_offline === 'true',
    'npm must be configured offline',
  )
  return problems
}

/** Default docker runner: resolves {code, stdout, stderr}; never rejects on exit codes. */
export function dockerRunner(bin) {
  return (args, { stdin, onOutput } = {}) =>
    new Promise((done) => {
      const child = spawn(bin, args, {
        // Its own process group: Ctrl-C must not kill a create that is about
        // to report the container it made.
        detached: args[0] === 'create',
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        onOutput?.(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
        onOutput?.(chunk)
      })
      child.on('error', (error) =>
        done({
          code: 127,
          stdout,
          stderr: String(error.code ?? error.message),
          spawnError: error,
        }),
      )
      child.on('close', (code) =>
        done({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }),
      )
      if (stdin) {
        child.stdin.on('error', () => {})
        stdin.pipe(child.stdin)
      }
    })
}

export class PrerequisiteError extends Error {}

/**
 * Fail-closed prerequisite checks: only reads (`version`, `image inspect`).
 * Nothing is started, pulled or created.
 */
export async function checkPrerequisites(docker, cfg) {
  const version = await docker(['version', '--format', '{{.Server.Version}}'])
  if (version.spawnError)
    throw new PrerequisiteError(
      `Docker CLI "${cfg.docker}" not found; install Docker or set OPENFARM_GATE_DOCKER.`,
    )
  if (version.code !== 0 || !version.stdout)
    throw new PrerequisiteError(
      `Docker daemon is not reachable: ${version.stderr || 'no server version reported'}.`,
    )
  const major = Number.parseInt(version.stdout, 10)
  if (!(major >= MIN_DOCKER_MAJOR))
    throw new PrerequisiteError(
      `Docker Engine ${version.stdout} is too old; ${MIN_DOCKER_MAJOR}+ is required for read-only image mounts.`,
    )

  const inspectImage = async (role, ref, envName) => {
    const result = await docker([
      'image',
      'inspect',
      '--format',
      '{{.Id}} {{.Os}}/{{.Architecture}}',
      ref,
    ])
    if (result.code !== 0)
      throw new PrerequisiteError(
        `${role} image "${ref}" is not present locally and will not be pulled. Load it, or point ${envName} at a local image.`,
      )
    const [id, platform] = result.stdout.split(' ')
    return { id, platform }
  }
  const node = await inspectImage(
    'Node 22',
    cfg.nodeImage,
    'OPENFARM_GATE_NODE_IMAGE',
  )
  const pg = await inspectImage(
    'PostgreSQL 17',
    cfg.pgImage,
    'OPENFARM_GATE_PG_IMAGE',
  )
  if (!node.platform.startsWith('linux/') || node.platform !== pg.platform)
    throw new PrerequisiteError(
      `Image platforms must match and be linux; got Node ${node.platform}, PostgreSQL ${pg.platform}.`,
    )

  return { dockerServer: version.stdout, node, pg, platform: node.platform }
}

function checkHostSpace(dir = tmpdir()) {
  const stat = statfsSync(dir)
  const free = stat.bavail * stat.bsize
  if (free < MIN_FREE_BYTES)
    throw new PrerequisiteError(
      `Only ${(free / 1024 ** 3).toFixed(1)} GiB free under ${dir}; ${MIN_FREE_BYTES / 1024 ** 3} GiB required.`,
    )
  return free
}

/** Source files for the container: tracked plus untracked-not-ignored, minus anything deleted on disk. */
export function listWorkspaceFiles(root = ROOT) {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 ** 2 },
  )
  if (listed.status !== 0)
    throw new PrerequisiteError(`git ls-files failed: ${listed.stderr}`)
  return listed.stdout.split('\0').filter((file) => {
    if (!file) return false
    try {
      lstatSync(join(root, file))
      return true
    } catch {
      return false
    }
  })
}

function workspaceArchive(root = ROOT) {
  const files = listWorkspaceFiles(root)
  const tar = spawn('tar', ['--no-xattrs', '--null', '-T', '-', '-cf', '-'], {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  tar.stdin.end(files.join('\0') + '\0')
  return { stream: tar.stdout, count: files.length }
}

/**
 * Owns the single runner container. `cleanup` first waits for an in-flight
 * create to return, so an interrupted run never orphans the container. It is
 * memoized: the signal handler and the finally block share one removal.
 */
export function containerSession({
  docker,
  names,
  say = () => {},
  record = async () => {},
}) {
  let creating
  let closing = false
  let cleaning
  const create = (args) => {
    if (closing) throw new Error('Interrupted: the container is not created')
    return (creating = docker(args))
  }
  const removeContainer = async () => {
    closing = true
    const made = await creating?.catch(() => undefined)
    if (made?.code !== 0) return false
    const owner = await docker([
      'inspect',
      '--format',
      `{{index .Config.Labels "${LABEL_KEY}"}} {{.Id}} {{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}`,
      names.container,
    ])
    const [label, containerId, ...volumes] = owner.stdout.trim().split(' ')
    let failed = false
    if (owner.code === 0 && label === names.id) {
      const removed = await docker(['rm', '-f', '-v', containerId])
      // `--rm` may already be removing it; `wait` covers that window.
      if (removed.code !== 0) await docker(['wait', containerId])
      const left = await docker(['ps', '-aq', '--filter', `id=${containerId}`])
      failed = left.code !== 0 || left.stdout !== '' || volumes.length > 0
      say(
        failed
          ? `cleanup FAILED for container ${containerId} (volumes: ${volumes.join(' ') || 'none'})`
          : `removed container ${containerId}`,
      )
    } else if (owner.code === 0) {
      failed = true
      say(`refusing to remove ${names.container}: ownership label mismatch`)
    }
    await record('cleanup.json', {
      container: names.container,
      runDir: names.runDir,
      volumes,
      failed,
    })
    return failed
  }
  return { create, cleanup: () => (cleaning ??= removeContainer()) }
}

const stamp = () => new Date().toISOString()

async function runGate(cfg, log) {
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  const names = resourceNames(id)
  const problems = findPlanProblems(planCalls(cfg, names))
  if (problems.length)
    throw new Error(`Unsafe docker plan: ${problems.join('; ')}`)

  const docker = dockerRunner(cfg.docker)
  const prerequisites = await checkPrerequisites(docker, cfg)
  const free = checkHostSpace()
  ensureBaseImage({
    projectDir: ROOT,
    nodeImage: cfg.nodeImage,
    bin: cfg.docker,
  })

  const ledger = mkdtempSync(join(tmpdir(), 'openfarm-check-all-docker-'))
  await mkdir(ledger, { recursive: true })
  const logFile = createWriteStream(join(ledger, 'check-all.log'))
  const out = (text) => {
    process.stdout.write(text)
    logFile.write(text)
  }
  const say = (message) => out(`[check-all-docker ${stamp()}] ${message}\n`)
  const record = (name, value) =>
    writeFile(join(ledger, name), `${JSON.stringify(value, null, 2)}\n`)

  const baseline = {
    ...names,
    config: cfg,
    prerequisites,
    hostFreeBytes: free,
    containers: (await docker(['ps', '-a', '--format', '{{.Names}}'])).stdout
      .split('\n')
      .filter(Boolean),
  }
  await record('task.json', baseline)
  say(`ledger: ${ledger}`)
  say(
    `images: node=${prerequisites.node.id} postgres=${prerequisites.pg.id}; dependencies: ${cfg.baseImage} (read-only)`,
  )

  let exitCode = 1
  let cleanupFailed = false
  const session = containerSession({ docker, names, say, record })
  let finishing
  const cleanup = () =>
    (finishing ??= (async () => {
      cleanupFailed = await session.cleanup()
      try {
        await removeRunDir(names.runDir, {
          image: cfg.pgImage,
          bin: cfg.docker,
        })
      } catch (error) {
        cleanupFailed = true
        say(`could not remove ${names.runDir}: ${error.message}`)
      }
    })())
  const stop = (signal) => async () => {
    say(`${signal} received; cleaning up`)
    await cleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  process.on('SIGINT', stop('SIGINT'))
  process.on('SIGTERM', stop('SIGTERM'))

  try {
    // mkdtemp-like privacy for the parent; the scratch folder must be writable
    // by the unprivileged service user inside the container.
    mkdirSync(names.runDir, { recursive: true, mode: 0o700 })
    mkdirSync(join(names.runDir, 'tmp'))
    chmodSync(join(names.runDir, 'tmp'), 0o1777)
    const made = await session.create(createArgs(cfg, names))
    if (made.code !== 0) throw new Error(`docker create failed: ${made.stderr}`)
    const started = await docker(['start', names.container])
    if (started.code !== 0)
      throw new Error(`docker start failed: ${started.stderr}`)
    await record('task.json', { ...baseline, containerId: made.stdout })

    for (const step of execPlan(names)) {
      say(`step: ${step.label}`)
      let stdin
      if (step.stdin === 'workspace') {
        const archive = workspaceArchive()
        stdin = archive.stream
        say(`copying ${archive.count} workspace files`)
      }
      const result = await docker(step.args, { stdin, onOutput: out })
      if (result.code !== 0) {
        say(`step "${step.label}" failed with exit code ${result.code}`)
        exitCode = result.code
        return exitCode
      }
    }
    say('check:all passed')
    exitCode = 0
    return exitCode
  } finally {
    await cleanup()
    const after = await docker(['ps', '-a', '--format', '{{.Names}}'])
    const leftovers = after.stdout
      .split('\n')
      .filter(
        (name) =>
          name.startsWith('openfarm-check-all-') &&
          !baseline.containers.includes(name),
      )
    say(
      `resource audit: task container removed=${!cleanupFailed}; leftover task containers=${leftovers.length}; ledger kept at ${ledger} (log + resource record, outside the repository)`,
    )
    await new Promise((done) => logFile.end(done))
    if (cleanupFailed && exitCode === 0) exitCode = 1
    process.exitCode = exitCode
  }
}

// ---------------------------------------------------------------- self-test

/** Fake docker backed by a table of canned replies; records every call. */
function fakeDocker(overrides = {}) {
  const calls = []
  const replies = {
    version: { code: 0, stdout: '29.8.2', stderr: '' },
    image: { code: 0, stdout: 'sha256:abc linux/arm64', stderr: '' },
    ...overrides,
  }
  const run = async (args) => {
    calls.push(args)
    const reply = replies[args[0]]
    return typeof reply === 'function' ? reply(args) : reply
  }
  run.calls = calls
  return run
}

export async function selfTest(log = console.log) {
  const cfg = resolveConfig({})
  const names = resourceNames('selftest')
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok })
    log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok ? '' : `: ${detail}`}`)
  }
  const rejects = async (name, run, pattern) => {
    try {
      await run()
      check(name, false, 'did not throw')
    } catch (error) {
      check(
        name,
        error instanceof PrerequisiteError && pattern.test(error.message),
        error.message,
      )
    }
  }

  // Command construction
  const calls = planCalls(cfg, names)
  const problems = findPlanProblems(calls)
  check(
    'docker plan satisfies the offline/no-privilege invariants',
    problems.length === 0,
    problems.join('; '),
  )
  const create = calls[0]
  check(
    'create never pulls and has no network',
    create[create.indexOf('--pull') + 1] === 'never' &&
      create[create.indexOf('--network') + 1] === 'none',
  )
  check(
    'create publishes no ports and bind-mounts only the run directory',
    !create.includes('-p') &&
      !create.some((a) => /docker\.sock/.test(a)) &&
      create
        .filter((a) => /^type=bind/.test(a))
        .every((a) => a === scratchMount(names.runDir)),
  )
  check(
    'create is --rm and masks the PostgreSQL image volume',
    create.includes('--rm') && create.includes(PG_VOLUME_MASK),
  )
  check(
    'gate step is exactly `npm run check:all`',
    calls.at(-1).slice(-3).join(' ') === 'npm run check:all',
  )
  check(
    'no step installs dependencies',
    !calls.some((c) => /\bnpm (ci|install|i)\b/.test(c.join(' '))),
  )
  check(
    'every image mount is read-only',
    create
      .filter((_, i) => create[i - 1] === '--mount')
      .filter((m) => m !== scratchMount(names.runDir))
      .every((m) => m.endsWith(',readonly')),
  )
  for (const [name, ok] of browserPlanChecks(cfg, calls, execPlan(names)))
    check(name, ok)
  for (const [name, ok] of runtimePlanChecks(
    calls,
    execPlan(names),
    names.runDir,
  ))
    check(name, ok)
  for (const [name, taint] of [
    ['--privileged', [['create', '--privileged']]],
    ['docker pull', [['pull', 'node:22']]],
    ['docker build', [['build', '.']]],
    ['published port', [['create', '-p', '3000:3000']]],
    [
      'docker socket mount',
      [
        [
          'create',
          '--mount',
          'type=bind,source=/var/run/docker.sock,destination=/s',
        ],
      ],
    ],
    [
      'network other than none',
      [['create', '--network', 'host', '--network=host']],
    ],
    ['dropped check:all', [['exec', 'x', 'npm', 'run', 'test']]],
    ['dropped browser preparation', []],
  ]) {
    const tainted = {
      'dropped check:all': () => calls.slice(0, -1).concat(taint),
      'dropped browser preparation': () =>
        calls.filter((call) => call.at(-1) !== PREPARE_BROWSER),
    }[name]
    const caught =
      findPlanProblems(tainted ? tainted() : [...calls, ...taint]).length > 0
    check(`plan checker rejects ${name}`, caught)
  }

  // Fail-closed prerequisites (fake docker; nothing started)
  const okDocker = fakeDocker()
  const ok = await checkPrerequisites(okDocker, cfg)
  check(
    'prerequisites pass with every image present',
    ok.platform === 'linux/arm64',
  )
  check(
    'prerequisite check only inspects, never starts or pulls',
    okDocker.calls.every(
      (c) =>
        ['version', 'image'].includes(c[0]) &&
        (c[0] !== 'image' || c[1] === 'inspect'),
    ),
  )
  await rejects(
    'missing Docker CLI fails closed',
    () =>
      checkPrerequisites(
        async () => ({
          code: 127,
          stdout: '',
          stderr: 'ENOENT',
          spawnError: new Error('x'),
        }),
        cfg,
      ),
    /Docker CLI .* not found/,
  )
  await rejects(
    'unreachable daemon fails closed',
    () =>
      checkPrerequisites(
        fakeDocker({
          version: { code: 1, stdout: '', stderr: 'Cannot connect' },
        }),
        cfg,
      ),
    /daemon is not reachable/,
  )
  await rejects(
    'old Docker Engine fails closed',
    () =>
      checkPrerequisites(
        fakeDocker({ version: { code: 0, stdout: '27.5.1', stderr: '' } }),
        cfg,
      ),
    /too old/,
  )
  await rejects(
    'missing Node image fails closed without pulling',
    () =>
      checkPrerequisites(
        fakeDocker({
          image: (a) =>
            a.at(-1) === cfg.nodeImage
              ? { code: 1, stdout: '', stderr: 'No such image' }
              : { code: 0, stdout: 'sha256:abc linux/arm64', stderr: '' },
        }),
        cfg,
      ),
    /Node 22 image .* not present locally and will not be pulled/,
  )
  await rejects(
    'missing PostgreSQL image fails closed without pulling',
    () =>
      checkPrerequisites(
        fakeDocker({
          image: (a) =>
            a.at(-1) === cfg.pgImage
              ? { code: 1, stdout: '', stderr: 'No such image' }
              : { code: 0, stdout: 'sha256:abc linux/arm64', stderr: '' },
        }),
        cfg,
      ),
    /PostgreSQL 17 image .* not present locally and will not be pulled/,
  )
  await rejects(
    'mismatched image platforms fail closed',
    () =>
      checkPrerequisites(
        fakeDocker({
          image: (a) => ({
            code: 0,
            stdout: `sha256:abc ${a.at(-1) === cfg.nodeImage ? 'linux/amd64' : 'linux/arm64'}`,
            stderr: '',
          }),
        }),
        cfg,
      ),
    /platforms must match/,
  )
  const dependencyCalls = []
  const reused = ensureBaseImage({
    nodeImage: cfg.nodeImage,
    docker: (args) => {
      dependencyCalls.push(args[0])
      return { status: 0 }
    },
  })
  check(
    'an existing dependency image is reused, not rebuilt',
    reused === cfg.baseImage && !dependencyCalls.includes('build'),
  )

  const failed = checks.filter((c) => !c.ok)
  log(
    failed.length
      ? `self-test FAILED (${failed.length}/${checks.length})`
      : `self-test passed (${checks.length} checks, no service started)`,
  )
  return failed.length === 0
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/check-all-docker.mjs [--self-test]')
    return 0
  }
  const unknown = argv.filter((a) => a !== '--self-test')
  if (unknown.length) {
    console.error(
      `Unknown argument: ${unknown.join(' ')}\nUsage: node scripts/check-all-docker.mjs [--self-test]`,
    )
    return 2
  }
  if (argv.includes('--self-test')) return (await selfTest()) ? 0 : 1
  try {
    await runGate(resolveConfig(), console.log)
    return process.exitCode ?? 1
  } catch (error) {
    console.error(`check-all-docker: ${error.message}`)
    return error instanceof PrerequisiteError ? 3 : 1
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(await main(process.argv.slice(2)))
}
