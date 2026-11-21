// Jobs history screen (/historico) evidence, run against Docker on Node 22 only.
//
//   node tests/e2e/run-jobs-docker.mjs
//
// - before: the pre-polish baseline (BASELINE_SHA), after: the current commit.
// - Each tree is exported with `git archive` into an owned temp directory,
//   installed offline from the npm cache and built with this Node 22 process.
//   Nothing is installed or served from the host beyond that build.
// - Each build is served by a node:22 container with no network at all.
// - Playwright runs in the Playwright image with the Node 22 binary from that
//   same node:22 image mounted over its own node, sharing the app container's
//   network namespace, so the app is reached on 127.0.0.1 and nothing else is
//   reachable. All /api calls are mocked; no printer or external service.
// - Screenshots are captured unconditionally in both phases and counted:
//   before by polish-jobs-capture.ts, after by the screenshot test of
//   polish-jobs.spec.ts. They stay in a temp directory outside git.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Last commit before the jobs screen was polished.
const BASELINE_SHA = '5f356def2ae102d559af1800878802e5bbd5052c'
const NODE_IMAGE =
  'node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee'
const PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright:v1.65.0-noble'
const PAGE = 'apps/farm/app/pages/historico.vue'
const EXPECTED_SHOTS = 28

if (process.versions.node.split('.')[0] !== '22') {
  console.error(`Node 22 is required, found ${process.version}`)
  process.exit(1)
}

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const evidence = mkdtempSync(join(tmpdir(), 'openfarm-jobs-evidence-'))
const work = mkdtempSync(join(tmpdir(), 'openfarm-jobs-trees-'))
const id = `jobs-evidence-${randomUUID()}`
const nodeBin = join(work, 'node22')
const commands = []
const containers = new Set()
const cleanup = []
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  NUXT_TELEMETRY_DISABLED: '1',
  npm_config_update_notifier: 'false',
}

const run = (command, args, options = {}) => {
  commands.push([command, ...args].join(' '))
  return execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env,
    ...options,
  })
}
const read = (command, args, options = {}) =>
  run(command, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options })
    .toString()
    .trim()
const docker = (args, options) => run('docker', args, options)

function exportTree(phase, sha) {
  const tree = join(work, phase)
  const archive = join(work, `${phase}.tar`)
  mkdirSync(tree)
  run('git', ['archive', '--format=tar', '-o', archive, sha])
  run('tar', ['-xf', archive, '-C', tree])
  rmSync(archive)
  run(
    'npm',
    ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: tree },
  )
  run('npm', ['run', 'build', '-w', '@open3dfarmmanager/farm'], { cwd: tree })
  return tree
}

async function startApp(phase, tree) {
  const name = `${id}-${phase}-app`
  docker([
    'create',
    '--pull=never',
    '--name',
    name,
    '--network',
    'none',
    '-v',
    `${join(tree, 'apps/farm/.output')}:/app:ro`,
    '-w',
    '/app',
    '-e',
    'NITRO_HOST=0.0.0.0',
    '-e',
    'NITRO_PORT=3000',
    NODE_IMAGE,
    'node',
    'server/index.mjs',
  ])
  containers.add(name)
  docker(['start', name])
  const probe =
    "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = spawnSync('docker', ['exec', name, 'node', '-e', probe])
    if (result.status === 0) return name
    await new Promise((done) => setTimeout(done, 1000))
  }
  docker(['logs', name])
  throw new Error(`${phase} application did not become healthy`)
}

function playwright(phase, app, testsTree, script) {
  const name = `${id}-${phase}-playwright`
  containers.add(name)
  docker([
    'run',
    '--rm',
    '--pull=never',
    '--name',
    name,
    '--network',
    `container:${app}`,
    '--shm-size=1g',
    '-v',
    `${nodeBin}:/usr/local/bin/node:ro`,
    '-v',
    `${testsTree}:/work`,
    '-v',
    `${evidence}:/evidence`,
    '-w',
    '/work',
    '-e',
    'CI=1',
    PLAYWRIGHT_IMAGE,
    'sh',
    '-ec',
    script,
  ])
  containers.delete(name)
}

const manifest = {
  evidence,
  startedAt: new Date().toISOString(),
  hostNode: process.version,
  images: { app: NODE_IMAGE, playwright: PLAYWRIGHT_IMAGE },
  commands,
  ownedResources: { tempDirs: [work, evidence], containers: [] },
  cleanup,
}
let failure
try {
  console.log(`Evidence: ${evidence}`)
  const baseline = read('git', ['rev-parse', `${BASELINE_SHA}^{commit}`])
  const after = read('git', ['rev-parse', 'HEAD'])
  if (
    spawnSync('git', ['merge-base', '--is-ancestor', baseline, after], {
      cwd: root,
    }).status !== 0
  )
    throw new Error('Baseline is not an ancestor of HEAD')
  if (
    spawnSync('git', ['diff', '--quiet', baseline, after, '--', PAGE], {
      cwd: root,
    }).status === 0
  )
    throw new Error('The jobs page is identical in baseline and HEAD')
  if (read('git', ['status', '--porcelain', '--', 'apps', 'tests']) !== '')
    throw new Error('Commit your changes first: the runner builds HEAD')
  manifest.shas = { baseline, after }

  // Linux Node 22 binary from the pinned node:22 image for the test runner.
  const extractor = `${id}-node22`
  docker(['create', '--pull=never', '--name', extractor, NODE_IMAGE, 'true'])
  containers.add(extractor)
  docker(['cp', `${extractor}:/usr/local/bin/node`, nodeBin])
  docker(['rm', '-f', extractor])
  containers.delete(extractor)

  const trees = {
    before: exportTree('before', baseline),
    after: exportTree('after', after),
  }
  writeFileSync(
    join(evidence, 'playwright.config.mjs'),
    `export default ${JSON.stringify({
      testDir: '/work/tests/e2e',
      timeout: 30000,
      expect: { timeout: 5000 },
      workers: 1,
      reporter: [['list']],
      use: { baseURL: 'http://127.0.0.1:3000', headless: true },
      outputDir: '/evidence/after/results',
    })}\n`,
  )
  manifest.containerNode = {}
  for (const phase of ['before', 'after']) {
    mkdirSync(join(evidence, phase), { recursive: true })
    const app = await startApp(phase, trees[phase])
    manifest.ownedResources.containers.push(app, `${id}-${phase}-playwright`)
    manifest.containerNode[`${phase}-app`] = read('docker', [
      'exec',
      app,
      'node',
      '-v',
    ])
    const steps = [`node -v > /evidence/${phase}-playwright-node.txt`]
    steps.push(
      phase === 'before'
        ? 'node tests/e2e/polish-jobs-capture.ts /evidence/before/shots'
        : 'POLISH_JOBS_SHOTS_DIR=/evidence/after/shots node node_modules/@playwright/test/cli.js test -c /evidence/playwright.config.mjs polish-jobs.spec.ts',
    )
    playwright(phase, app, trees.after, steps.join('\n'))
    docker(['rm', '-f', app])
    containers.delete(app)
    cleanup.push(`removed container ${app}`)
    const shots = readdirSync(join(evidence, phase, 'shots')).filter((name) =>
      name.endsWith('.png'),
    )
    if (shots.length !== EXPECTED_SHOTS)
      throw new Error(`${phase}: ${shots.length} of ${EXPECTED_SHOTS} shots`)
    manifest[`${phase}Shots`] = shots.length
  }
  // Existing assertions for this page keep running on this Node 22, offline.
  // The unit tests use an in-process mock API on 127.0.0.1 and the bundled
  // Chromium; their native bindings are host-platform, so they cannot run in
  // the Linux containers. No application service runs outside Docker.
  const vitest = 'node_modules/vitest/vitest.mjs'
  const unitEnv = { ...env, OPENFARM_BROWSER: 'bundled' }
  run(
    'node',
    [
      vitest,
      'run',
      'tests/unit/job-history.test.ts',
      'tests/unit/job-history-library-link.test.ts',
    ],
    { cwd: trees.after, env: unitEnv },
  )
  run(
    'node',
    [
      vitest,
      'run',
      'tests/unit/replay-wiring.test.ts',
      'tests/unit/page-states.test.ts',
      '-t',
      'historico|Histórico',
    ],
    { cwd: trees.after, env: unitEnv },
  )
} catch (error) {
  failure = error
} finally {
  for (const name of containers) {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'inherit' })
    cleanup.push(`removed container ${name}`)
  }
  rmSync(work, { recursive: true, force: true })
  cleanup.push(`removed ${work}`)
  manifest.finishedAt = new Date().toISOString()
  manifest.result = failure ? `failed: ${failure.message}` : 'passed'
  if (existsSync(evidence))
    writeFileSync(
      join(evidence, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
  console.log(`Evidence kept at ${evidence}`)
}
if (failure) throw failure
