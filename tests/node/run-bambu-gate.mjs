#!/usr/bin/env node
// Docker-only targeted check for the Bambu control gate (tests/node/bambu-control.test.ts).
//
// Every service (the in-process synthetic Bambu MQTT broker and the test runner) runs inside
// disposable containers. Nothing runs on the host except `git` and `docker`. The run is offline:
//   * no image is pulled (`--pull never`); the runner image must already exist locally. The only
//     image built is the dependency image, once per lockfile (scripts/docker-base-image.mjs);
//   * locked dependencies are copied from that image; nothing is installed per run;
//   * every `--rm` container (seed and test) has no network (loopback only), so only local mocks
//     can answer: no registry, no printer, no paid API.
// A missing image or a Node/openssl mismatch fails the run clearly.
//
// Prerequisites (shared with scripts/check-all-docker.mjs; override via env):
//   OPENFARM_GATE_NODE_IMAGE        default openfarm-e2e-node<.nvmrc>:latest (Node + openssl;
//                                   its Node version must equal the connector Dockerfile's pin)
//
// Usage:
//   node tests/node/run-bambu-gate.mjs [--ref <git-ref>]... [--repeat N] [--cpus X]
//                                      [--file <tests/node/*.test.ts>] [--pattern <name regex>]
//                                      [--test-from <git-ref>] [--verbose]
//   Default: --ref HEAD --repeat 1 --file tests/node/bambu-control.test.ts
//   --test-from overlays only the test file from another ref onto every --ref, e.g. to run the
//   fixed test against the unfixed baseline and show it reproduces the failure there.
//
// Resource ownership: every container this run creates carries the label `openfarm.bambu-gate=<runId>`
// and a `<runId>-` name prefix, and every host directory lives under one run directory in
// ${XDG_CACHE_HOME:-~/.cache}/openfarm-docker/. All of them are removed on exit, on failure and on
// SIGINT/SIGTERM (after any in-flight create), then the leftovers are verified (exit 2 if any).
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  browserNodeImage,
  ensureBaseImage,
  seedNodeModules,
} from '../../scripts/docker-base-image.mjs'
import {
  createLifecycle,
  createRunDir,
  removeRunDir,
} from '../../scripts/docker-run-lib.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LABEL = 'openfarm.bambu-gate'
const runId = `bambu-gate-${randomBytes(4).toString('hex')}`

function parseArgs(argv) {
  const options = {
    refs: [],
    repeat: 1,
    cpus: undefined,
    file: 'tests/node/bambu-control.test.ts',
    pattern: undefined,
    testFrom: undefined,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--verbose') {
      options.verbose = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) throw new Error(`Missing value for ${flag}`)
    if (flag === '--ref') options.refs.push(value)
    else if (flag === '--repeat') options.repeat = Number(value)
    else if (flag === '--cpus') options.cpus = value
    else if (flag === '--file') options.file = value
    else if (flag === '--pattern') options.pattern = value
    else if (flag === '--test-from') options.testFrom = value
    else throw new Error(`Unknown flag ${flag}`)
  }
  if (options.refs.length === 0) options.refs.push('HEAD')
  if (!Number.isSafeInteger(options.repeat) || options.repeat < 1)
    throw new Error('--repeat must be a positive integer')
  if (!/^tests\/node\/[\w.-]+\.test\.ts$/.test(options.file))
    throw new Error('--file must be a tests/node/*.test.ts path')
  if (options.cpus !== undefined && !/^\d+(\.\d+)?$/.test(options.cpus))
    throw new Error('--cpus must be a number')
  return options
}

function run(command, args, { input, cwd } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

const lifecycle = createLifecycle()

async function container(args) {
  const result = await lifecycle.run(args)
  return { status: result.status, output: result.stdout + result.stderr }
}

const state = { root: undefined, cleaned: false }

function leftovers() {
  const filter = ['--filter', `label=${LABEL}=${runId}`]
  const containers = run('docker', ['ps', '-aq', ...filter])
    .stdout.trim()
    .split('\n')
    .filter(Boolean)
  const volumes = run('docker', ['volume', 'ls', '-q', ...filter])
    .stdout.trim()
    .split('\n')
    .filter(Boolean)
  const images = run('docker', ['images', '-q', ...filter])
    .stdout.trim()
    .split('\n')
    .filter(Boolean)
  const directory = state.root && existsSync(state.root) ? [state.root] : []
  return { containers, volumes, images, directory }
}

async function cleanup() {
  if (state.cleaned) return leftovers()
  state.cleaned = true
  await lifecycle.cleanup()
  const filter = ['--filter', `label=${LABEL}=${runId}`]
  const containers = run('docker', ['ps', '-aq', ...filter])
    .stdout.trim()
    .split('\n')
    .filter(Boolean)
  if (containers.length) run('docker', ['rm', '-f', '-v', ...containers])
  return leftovers()
}

const config = {
  image: process.env.OPENFARM_GATE_NODE_IMAGE || browserNodeImage(repoRoot),
}

function nodeImage() {
  // Same digest-pinned image the connector ships on; keeps the Node version identical to CI.
  const dockerfile = readFileSync(
    join(repoRoot, 'packages/connector/Dockerfile'),
    'utf8',
  )
  const match = /^FROM (node:\S+@sha256:[0-9a-f]{64})/m.exec(dockerfile)
  if (!match)
    throw new Error('Pinned node image not found in connector Dockerfile')
  return match[1]
}

// The local runner image must run exactly the Node version the connector pins.
function pinnedNodeVersion() {
  const match = /^node:(\d+\.\d+\.\d+)/.exec(nodeImage())
  if (!match) throw new Error(`Pinned node image ${nodeImage()} has no version`)
  return match[1]
}

const OFFLINE_HINT =
  'The Bambu gate runs offline and never pulls. Provide it locally ' +
  '(see the header of tests/node/run-bambu-gate.mjs / scripts/check-all-docker.mjs).'

function resolveRef(ref) {
  const resolved = run('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repoRoot,
  })
  if (resolved.status !== 0) throw new Error(`Unknown git ref ${ref}`)
  return resolved.stdout.trim()
}

function overlayTest(testFrom, file, directory) {
  const shown = spawnSync('git', ['show', `${resolveRef(testFrom)}:${file}`], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (shown.status !== 0) throw new Error(`${file} not found at ${testFrom}`)
  writeFileSync(join(directory, file), shown.stdout)
}

function exportRef(ref, directory) {
  const sha = resolveRef(ref)
  mkdirSync(directory, { recursive: true })
  const archive = spawnSync('git', ['archive', '--format=tar', sha], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 1024,
  })
  if (archive.status !== 0) throw new Error(`git archive failed for ${ref}`)
  const extract = spawnSync('tar', ['-x', '-C', directory], {
    input: archive.stdout,
    maxBuffer: 1024 * 1024 * 1024,
  })
  if (extract.status !== 0) throw new Error(`tar extract failed for ${ref}`)
  return sha
}

function dependencyKey(directory) {
  const hash = createHash('sha256')
  const manifests = ['package.json', 'package-lock.json', '.npmrc']
  for (const group of ['apps', 'packages'])
    for (const entry of readdirSync(join(directory, group)).sort()) {
      const manifest = join(group, entry, 'package.json')
      if (existsSync(join(directory, manifest))) manifests.push(manifest)
    }
  for (const manifest of manifests)
    if (existsSync(join(directory, manifest)))
      hash.update(manifest).update(readFileSync(join(directory, manifest)))
  return hash.digest('hex').slice(0, 12)
}

const common = (name) => [
  '--name',
  `${runId}-${name}`,
  '--label',
  `${LABEL}=${runId}`,
  '--pull',
  'never',
  '--network',
  'none',
]

// The synthetic broker shells out to `openssl` to mint a throwaway TLS identity, so the local
// runner image must carry it next to the pinned Node version. Nothing is pulled or built.
async function checkPrerequisites() {
  if (run('docker', ['image', 'inspect', config.image]).status !== 0)
    throw new Error(
      `Runner image ${config.image} is not available locally. ${OFFLINE_HINT}`,
    )
  const expected = pinnedNodeVersion()
  const probe = await container(bambuProbeArgs(config.image))
  const lines = probe.output.trim().split('\n')
  if (lines[0] !== expected)
    throw new Error(
      `Runner image ${config.image} has Node ${lines[0] || '?'}; the connector pins ${expected}. ${OFFLINE_HINT}`,
    )
  if (!lines.includes('openssl-ok'))
    throw new Error(
      `Runner image ${config.image} has no openssl. ${OFFLINE_HINT}`,
    )
  return expected
}

export function bambuProbeArgs(image) {
  return [
    'run',
    '--rm',
    ...common('probe'),
    image,
    'sh',
    '-c',
    'node -p process.versions.node && command -v openssl >/dev/null && echo openssl-ok',
  ]
}

export function bambuSeedArgs({ image, directory, label }) {
  return [
    'run',
    '--rm',
    ...common(label),
    '-v',
    `${directory}:/work`,
    '--tmpfs',
    '/tmp:rw,size=1g',
    image,
    'sh',
    '-ec',
    seedNodeModules('/work'),
  ]
}

export function bambuTestArgs({ image, directory, label, cpus, testArgs }) {
  return [
    'run',
    '--rm',
    ...common(label),
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=256m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--memory',
    '2g',
    ...(cpus ? ['--cpus', cpus] : []),
    '--user',
    '1000:1000',
    '-e',
    'HOME=/tmp',
    '-e',
    'NODE_ENV=test',
    '-v',
    `${directory}:/work:ro`,
    '-w',
    '/work',
    image,
    ...testArgs,
  ]
}

// Each ref gets the dependency image of its own lockfile, copied into its tree.
async function seedDependencies(directory, key) {
  const image = ensureBaseImage({
    projectDir: directory,
    nodeImage: config.image,
  })
  const result = await container(
    bambuSeedArgs({ image, directory, label: `seed-${key}` }),
  )
  if (result.status !== 0)
    throw new Error(`dependency seed failed\n${result.output.slice(-4000)}`)
}

function failureExcerpt(output) {
  const lines = output.split('\n')
  const keep = []
  for (let i = 0; i < lines.length; i++) {
    if (
      /^\s*(not ok|error:|code:|failureType:)/.test(lines[i]) ||
      /^\s*[+-] ?\{|^\s*[+-]\s+(command|sequence_id)|^\s*\+? ?'?get_version/.test(
        lines[i],
      ) ||
      /Expected values to be|actual:|expected:|get_version/.test(lines[i])
    )
      keep.push(lines[i].trimEnd())
  }
  return [...new Set(keep)].slice(0, 24).join('\n')
}

async function runTest(image, directory, options, label) {
  const testArgs = [
    'node',
    '--test',
    '--test-concurrency=1',
    '--test-timeout=120000',
    '--test-force-exit',
    '--test-reporter=tap',
    ...(options.pattern ? [`--test-name-pattern=${options.pattern}`] : []),
    options.file,
  ]
  const started = Date.now()
  const result = await container(
    bambuTestArgs({
      image,
      directory,
      label,
      cpus: options.cpus,
      testArgs,
    }),
  )
  const count = (name) =>
    Number(new RegExp(`^# ${name} (\\d+)`, 'm').exec(result.output)?.[1] ?? NaN)
  const caseLines = result.output.match(/^\s*(?:ok|not ok) \d+ - .+$/gm) ?? []
  const executed = caseLines.filter(
    (line) =>
      !line.includes(`- ${options.file}`) && !/\s# SKIP(?:\s|$)/.test(line),
  ).length
  const pass = count('pass')
  const fail = count('fail')
  const validReport =
    Number.isSafeInteger(executed) &&
    executed > 0 &&
    Number.isSafeInteger(pass) &&
    pass === executed &&
    Number.isSafeInteger(fail)
  return {
    passed:
      result.status === 0 && validReport && fail === 0 && pass === executed,
    status: result.status,
    seconds: (Date.now() - started) / 1000,
    pass,
    fail,
    excerpt:
      result.status === 0
        ? ''
        : options.verbose
          ? result.output.trimEnd()
          : failureExcerpt(result.output),
    command: `docker ${[
      'run',
      '--pull never',
      '--network none',
      '--read-only',
      '--cap-drop ALL',
      ...(options.cpus ? [`--cpus ${options.cpus}`] : []),
      `<runner=${config.image}>`,
      ...testArgs,
    ].join(' ')}`,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (run('docker', ['info', '--format', '{{.ServerVersion}}']).status !== 0)
    throw new Error('Docker daemon unavailable')
  const nodeVersion = await checkPrerequisites()
  const image = config.image
  state.root = createRunDir(runId)
  console.log(
    `run ${runId}  offline  node ${nodeVersion}  runner ${image}  file ${options.file}` +
      (options.testFrom ? `  test-from ${options.testFrom}` : ''),
  )
  const summary = []
  for (const ref of options.refs) {
    const directory = join(state.root, `src-${summary.length}`)
    const sha = exportRef(ref, directory)
    if (options.testFrom) overlayTest(options.testFrom, options.file, directory)
    await seedDependencies(directory, summary.length)
    const results = []
    for (let n = 1; n <= options.repeat; n++) {
      const result = await runTest(
        image,
        directory,
        options,
        `test-${summary.length}-${n}`,
      )
      results.push(result)
      console.log(
        `${ref}@${sha.slice(0, 12)} run ${n}/${options.repeat}: ${result.passed ? 'PASS' : 'FAIL'} ` +
          `(exit ${result.status}, pass ${result.pass}, fail ${result.fail}, ${result.seconds.toFixed(1)}s)`,
      )
      if (!result.passed) console.log(result.excerpt)
    }
    summary.push({ ref, sha, results })
    if (results[0]) console.log(`command: ${results[0].command}`)
  }
  console.log('\nsummary')
  let failed = false
  for (const { ref, sha, results } of summary) {
    const bad = results.filter((r) => !r.passed).length
    if (bad) failed = true
    console.log(
      `  ${ref} (${sha.slice(0, 12)}): ${results.length - bad}/${results.length} passed`,
    )
  }
  return failed ? 1 : 0
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  lifecycle.finalizer(async () => {
    if (state.root) await removeRunDir(state.root, { image: config.image })
  })
  lifecycle.installSignals()
  let code = 1
  try {
    code = await main()
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
  } finally {
    const left = await cleanup()
    const clean =
      left.containers.length +
        left.volumes.length +
        left.images.length +
        left.directory.length ===
      0
    console.log(
      `cleanup: containers=${left.containers.length} volumes=${left.volumes.length} ` +
        `images=${left.images.length} ` +
        `hostDirs=${left.directory.length} (${clean ? 'clean' : 'LEFTOVERS'})`,
    )
    if (!clean) code = 2
  }
  process.exit(code)
}
