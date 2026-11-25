// SPDX-License-Identifier: MIT
// Deterministic Node 22 Docker evidence runner for the connector queue-clock and
// test-timeout failures seen in the final gate. It runs only the focused files
// below, with no network and no physical printer, and writes one JSON summary.
//
//   node scripts/test-queue-clock-docker.mjs [--profile gate|quiet|loaded|isolation|overlay|disk|stress|all]
//        [--cpus N] [--load N] [--test-timeout MS] [--file path]... [--evidence-dir DIR] [--profile-timeout MS]
//
// Default profile `gate` runs quiet, loaded and isolation: all deterministic, exit 0
// when they pass. overlay, disk and stress are diagnostics whose outcome depends
// on the host disk, so they run only when named (or with `all`).
//
// isolation: mixed-telemetry-runtime with a forced 150 ms test timeout. Timeouts
//           are expected; the profile passes only if none leaks into a later
//           test as `Queue clock regressed`.
// quiet   : the container owns --cpus CPUs alone; /tmp is tmpfs.
// loaded  : the same container is starved by --load busy-loop processes, which
//           reproduces shared-host CPU contention deterministically; /tmp is tmpfs.
// disk    : host-disk /tmp plus --load background writers that append and fsync
//           on the same disk, reproducing shared-disk fsync contention.
// stress  : one CPU, --load CPU spinners and --load fsync writers together.
// overlay : quiet CPU, but /tmp stays on the host disk (a bind directory), so
//           every fsync reaches the shared disk. Runs only the durable
//           heartbeat backlog file unless --file is given.
// Each run uses task-named `--rm` containers. Tests run in a copy of the working
// tree under ${XDG_CACHE_HOME:-~/.cache}/openfarm-docker/ with node_modules
// copied from the dependency image (scripts/docker-base-image.mjs); nothing is
// installed per run (--install is accepted and ignored) and nothing is built.
// The run directory is removed on exit; the evidence directory is kept.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listWorkspaceFiles } from './check-all-docker.mjs'
import {
  DIAGNOSTIC_NODE_IMAGE,
  ensureBaseImage,
  seedNodeModules,
} from './docker-base-image.mjs'
import {
  TMPFS_TMP,
  copyWorkspace,
  createLifecycle,
  createRunDir,
  removeRunDir,
} from './docker-run-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PREFIX = 'o3dfm-qclock-557'
const DEFAULT_FILES = [
  'tests/unit/mixed-telemetry-runtime.test.ts',
  'tests/unit/telemetry-scope-handover.test.ts',
  'tests/unit/heartbeat-coalesce.test.ts',
]
const ISOLATION_FILES = ['tests/unit/mixed-telemetry-runtime.test.ts']
const DURABLE_FILES = ['tests/unit/heartbeat-coalesce.test.ts']

function parse(argv) {
  const options = {
    profile: 'gate',
    profileTimeout: 900000,
    cpus: 4,
    load: 8,
    files: [],
    testTimeout: undefined,
    evidenceDir: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${flag} needs a value`)
      return next
    }
    if (flag === '--install')
      console.error('--install is ignored: dependencies are preinstalled')
    else if (flag === '--profile') options.profile = value()
    else if (flag === '--cpus') options.cpus = Number(value())
    else if (flag === '--load') options.load = Number(value())
    else if (flag === '--file') options.files.push(value())
    else if (flag === '--profile-timeout')
      options.profileTimeout = Number(value())
    else if (flag === '--test-timeout') options.testTimeout = Number(value())
    else if (flag === '--evidence-dir') options.evidenceDir = resolve(value())
    else throw new Error(`unknown argument ${flag}`)
  }
  if (
    ![
      'gate',
      'quiet',
      'loaded',
      'isolation',
      'overlay',
      'disk',
      'stress',
      'all',
    ].includes(options.profile)
  )
    throw new Error(
      '--profile must be gate, quiet, loaded, isolation, overlay, disk, stress or all',
    )
  if (
    !(options.cpus > 0) ||
    !Number.isInteger(options.load) ||
    options.load < 0
  )
    throw new Error('--cpus must be positive and --load a non-negative integer')
  options.explicitFiles = options.files.length > 0
  if (!options.files.length) options.files = DEFAULT_FILES
  for (const file of options.files)
    if (!/^tests\/unit\/[\w./-]+\.test\.ts$/.test(file) || file.includes('..'))
      throw new Error(`refusing test path ${file}`)
  return options
}

const ids =
  typeof process.getuid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : []

export function queueClockRunArgs({ name, cpus, tmpDir, runDir, image }) {
  return [
    'run',
    '--rm',
    '--pull=never',
    '--name',
    name,
    '--network',
    'none',
    ...ids,
    '--cpus',
    String(cpus),
    // Without a directory /tmp is a tmpfs; with one it is on the host disk.
    ...(tmpDir ? ['-v', `${tmpDir}:/tmp`] : ['--tmpfs', TMPFS_TMP]),
    '-e',
    'HOME=/tmp',
    '-e',
    'TMPDIR=/tmp',
    '-e',
    'CI=1',
    '-v',
    `${join(runDir, 'work')}:/workspace`,
    '-v',
    `${join(runDir, 'evidence')}:/evidence`,
    '-w',
    '/workspace',
    image,
  ]
}

export function queueClockSeedArgs({ runDir, image }) {
  return [
    ...queueClockRunArgs({
      name: `${PREFIX}-seed-${process.pid}`,
      cpus: 2,
      runDir,
      image,
    }),
    'sh',
    '-ec',
    seedNodeModules('/workspace'),
  ]
}

// Busy loops inside the same container compete for its CPU quota exactly as
// neighbouring workloads do on a shared host, without touching host settings.
const BUSY = 'while (true) {}'
const WRITER =
  'const fs=require("fs");const fd=fs.openSync(process.argv[1],"w");const b=Buffer.alloc(65536,97);while(true){fs.writeSync(fd,b,0,b.length,0);fs.fsyncSync(fd)}'

async function runProfile(profile, options, evidence, run) {
  const name = `${PREFIX}-${profile}-${process.pid}`
  const load =
    profile === 'loaded' || profile === 'disk' || profile === 'stress'
      ? options.load
      : 0
  const writers = `for i in $(seq 1 ${load}); do node -e '${WRITER}' /tmp/spin-$i & done`
  const spinners = `for i in $(seq 1 ${load}); do node -e '${BUSY}' & done`
  const spawnLoad =
    profile === 'stress'
      ? `${writers}; ${spinners}`
      : profile === 'disk'
        ? `for i in $(seq 1 ${load}); do node -e '${WRITER}' /tmp/spin-$i & done`
        : `for i in $(seq 1 ${load}); do node -e '${BUSY}' & done`
  const files = options.explicitFiles
    ? options.files
    : profile === 'overlay'
      ? DURABLE_FILES
      : profile === 'isolation'
        ? ISOLATION_FILES
        : options.files
  const testTimeout =
    profile === 'isolation' ? (options.testTimeout ?? 150) : options.testTimeout
  const reportPath = `/evidence/${profile}.report.json`
  const script = [
    spawnLoad,
    `node node_modules/vitest/vitest.mjs run --maxWorkers=1 ${testTimeout ? `--testTimeout=${testTimeout} ` : ''}--reporter=default --reporter=json --outputFile=${reportPath} ${files.join(' ')}`,
    'code=$?',
    'kill $(jobs -p) 2>/dev/null',
    'exit $code',
  ].join('; ')
  const onDisk =
    profile === 'overlay' || profile === 'disk' || profile === 'stress'
  const tmpDir = onDisk ? join(run.runDir, `tmp-${profile}`) : undefined
  if (tmpDir) mkdirSync(tmpDir)
  const started = Date.now()
  const result = await run.lifecycle.run(
    [
      ...queueClockRunArgs({
        name,
        cpus:
          profile === 'loaded' ? 2 : profile === 'stress' ? 1 : options.cpus,
        tmpDir,
        runDir: run.runDir,
        image: run.image,
      }),
      'bash',
      '-c',
      script,
    ],
    { timeout: options.profileTimeout },
  )
  // The fsync writers' files are disposable and can be large.
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  const wallMs = Date.now() - started
  const reportFile = join(evidence, `${profile}.report.json`)
  const written = join(run.runDir, 'evidence', `${profile}.report.json`)
  try {
    cpSync(written, reportFile)
  } catch {
    // no report: the run failed or timed out
  }
  let report
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8'))
  } catch {
    report = undefined
  }
  const tests = (report?.testResults ?? []).flatMap((file) =>
    file.assertionResults.map((test) => ({
      file: file.name.replace(`${'/workspace'}/`, ''),
      name: test.fullName,
      status: test.status,
      durationMs: Math.round(test.duration ?? 0),
      message: (test.failureMessages ?? []).join('\n').split('\n')[0] ?? '',
    })),
  )
  const unhandled =
    (result.stdout + result.stderr).match(/Queue clock regressed/g)?.length ?? 0
  const summary = {
    profile,
    cpus: profile === 'loaded' ? 2 : profile === 'stress' ? 1 : options.cpus,
    loadKind:
      profile === 'disk'
        ? 'fsync-writers'
        : profile === 'stress'
          ? 'cpu-spin+fsync-writers'
          : load
            ? 'cpu-spin'
            : 'none',
    tmp: onDisk ? 'disk' : 'tmpfs',
    busyLoops: load,
    exitCode:
      profile === 'isolation'
        ? report && unhandled === 0
          ? 0
          : 1
        : result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    wallMs,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status === 'failed').length,
    timeouts: tests.filter((t) => /timed out/i.test(t.message)).length,
    queueClockRegressions: unhandled,
    tests,
  }
  writeFileSync(
    join(evidence, `${profile}.json`),
    JSON.stringify(summary, null, 2),
  )
  writeFileSync(join(evidence, `${profile}.log`), result.stdout + result.stderr)
  return summary
}

async function main() {
  const options = parse(process.argv.slice(2))
  const evidence =
    options.evidenceDir ?? mkdtempSync(join(tmpdir(), 'qclock-evidence-'))
  mkdirSync(evidence, { recursive: true })
  const image = ensureBaseImage({
    projectDir: ROOT,
    nodeImage: DIAGNOSTIC_NODE_IMAGE,
    allowPull: true,
  })
  const runDir = createRunDir('queue-clock')
  const lifecycle = createLifecycle()
  lifecycle.finalizer(() => removeRunDir(runDir, { image }))
  lifecycle.installSignals()
  const profiles =
    options.profile === 'all'
      ? ['quiet', 'loaded', 'isolation', 'overlay', 'disk', 'stress']
      : options.profile === 'gate'
        ? ['quiet', 'loaded', 'isolation']
        : [options.profile]
  const results = []
  try {
    copyWorkspace(ROOT, listWorkspaceFiles(ROOT), join(runDir, 'work'))
    mkdirSync(join(runDir, 'evidence'))
    const seeded = await lifecycle.run(queueClockSeedArgs({ runDir, image }))
    if (seeded.status !== 0)
      throw new Error(`dependency seed failed: ${seeded.stderr}`)
    for (const profile of profiles)
      results.push(
        await runProfile(profile, options, evidence, {
          lifecycle,
          runDir,
          image,
        }),
      )
  } finally {
    await lifecycle.cleanup()
  }
  for (const r of results)
    console.log(
      `${r.profile}: exit=${r.exitCode} passed=${r.passed} failed=${r.failed} timeouts=${r.timeouts} clockRegressions=${r.queueClockRegressions} wall=${r.wallMs}ms (cpus=${r.cpus} busy=${r.busyLoops} tmp=${r.tmp})`,
    )
  console.log(`evidence: ${evidence}`)
  process.exitCode = results.every((r) => r.exitCode === 0) ? 0 : 1
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main()
  } catch (error) {
    console.error(`test-queue-clock-docker: ${error.message}`)
    process.exitCode = 2
  }
}
