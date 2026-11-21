// SPDX-License-Identifier: MIT
// Deterministic Node 22 Docker evidence runner for the connector queue-clock and
// test-timeout failures seen in the final gate. It runs only the focused files
// below, with no network and no physical printer, and writes one JSON summary.
//
//   node scripts/test-queue-clock-docker.mjs [--install] [--profile gate|quiet|loaded|isolation|overlay|disk|stress|all]
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
// disk    : overlay /tmp plus --load background writers that append and fsync
//           on the same overlay, reproducing shared-disk fsync contention.
// stress  : one CPU, --load CPU spinners and --load fsync writers together.
// overlay : quiet CPU, but /tmp stays on the container overlay filesystem, so
//           every fsync reaches the shared host disk. Runs only the durable
//           heartbeat backlog file unless --file is given.
// Each run uses a task-named container and removes it on exit. The workspace is
// mounted read-write only so node_modules can live beside it; nothing is built.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'node:22-bookworm'
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
    install: false,
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
    if (flag === '--install') options.install = true
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

function docker(args, input, options = {}) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    timeout: options.profileTimeout,
    maxBuffer: 64 * 1024 * 1024,
  })
}

function base(name, cpus, tmpfs, evidence) {
  return [
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    'none',
    ...ids,
    '--cpus',
    String(cpus),
    ...(tmpfs ? ['--tmpfs', '/tmp:rw,mode=1777'] : []),
    '-e',
    'HOME=/tmp',
    '-e',
    'TMPDIR=/tmp',
    '-e',
    'CI=1',
    '-v',
    `${ROOT}:/workspace`,
    '-v',
    `${evidence}:/evidence`,
    '-w',
    '/workspace',
    IMAGE,
  ]
}

function install(cache) {
  const name = `${PREFIX}-install`
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      name,
      ...ids,
      '-e',
      'HOME=/tmp',
      '-e',
      'npm_config_cache=/cache',
      '-v',
      `${ROOT}:/workspace`,
      '-v',
      `${cache}:/cache`,
      '-w',
      '/workspace',
      IMAGE,
      'npm',
      'ci',
      '--no-audit',
      '--no-fund',
    ],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error('npm ci failed in Docker')
}

// Busy loops inside the same container compete for its CPU quota exactly as
// neighbouring workloads do on a shared host, without touching host settings.
const BUSY = 'while (true) {}'
const WRITER =
  'const fs=require("fs");const fd=fs.openSync(process.argv[1],"w");const b=Buffer.alloc(65536,97);while(true){fs.writeSync(fd,b,0,b.length,0);fs.fsyncSync(fd)}'

function runProfile(profile, options, evidence) {
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
  const started = Date.now()
  const result = docker(
    [
      ...base(
        name,
        profile === 'loaded' ? 2 : profile === 'stress' ? 1 : options.cpus,
        profile !== 'overlay' && profile !== 'disk' && profile !== 'stress',
        evidence,
      ),
      'bash',
      '-c',
      script,
    ],
    undefined,
    options,
  )
  docker(['rm', '-f', name])
  const wallMs = Date.now() - started
  const reportFile = join(evidence, `${profile}.report.json`)
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
    tmp:
      profile === 'overlay' || profile === 'disk' || profile === 'stress'
        ? 'overlay'
        : 'tmpfs',
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

function main() {
  const options = parse(process.argv.slice(2))
  const evidence =
    options.evidenceDir ?? mkdtempSync(join(tmpdir(), 'qclock-evidence-'))
  mkdirSync(evidence, { recursive: true })
  if (options.install) {
    const cache = join(evidence, 'npm-cache')
    mkdirSync(cache, { recursive: true })
    install(cache)
  }
  const profiles =
    options.profile === 'all'
      ? ['quiet', 'loaded', 'isolation', 'overlay', 'disk', 'stress']
      : options.profile === 'gate'
        ? ['quiet', 'loaded', 'isolation']
        : [options.profile]
  const results = profiles.map((profile) =>
    runProfile(profile, options, evidence),
  )
  for (const r of results)
    console.log(
      `${r.profile}: exit=${r.exitCode} passed=${r.passed} failed=${r.failed} timeouts=${r.timeouts} clockRegressions=${r.queueClockRegressions} wall=${r.wallMs}ms (cpus=${r.cpus} busy=${r.busyLoops} tmp=${r.tmp})`,
    )
  console.log(`evidence: ${evidence}`)
  process.exitCode = results.every((r) => r.exitCode === 0) ? 0 : 1
}

try {
  main()
} catch (error) {
  console.error(`test-queue-clock-docker: ${error.message}`)
  process.exitCode = 2
}
