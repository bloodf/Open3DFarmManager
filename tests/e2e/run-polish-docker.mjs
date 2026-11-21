// Shared offline Docker evidence runner for screen-polish units, Node 22 only.
//
//   node tests/e2e/run-polish-docker.mjs --screen <name> --spec <spec path> \
//     --baseline <sha> [--min-shots N] [options]
//
//   --screen    short name (jobs, farm, ...): names temp dirs and containers,
//               and sets the default screenshot env var POLISH_<NAME>_SHOTS_DIR.
//   --spec      Playwright spec of the screen, relative to the repo root.
//   --baseline  last commit before the polish (must be an ancestor of HEAD).
//   --min-shots minimum screenshots per phase (default 8).
//   Other options (run with --help): --min-before-shots, --shots-env,
//   --capture-grep, --capture-script, --page, --unit.
//
// Phases
// - before: the --baseline tree is built and served; the spec (taken from the
//   HEAD tree) is run against it in CAPTURE MODE. Capture mode is: the spec's
//   screenshot test only (--grep, default 'screenshots of real screen states')
//   with POLISH_CAPTURE=1 in the environment, and a non-zero exit of that run
//   is tolerated because the baseline is not expected to satisfy the polished
//   assertions. Only the screenshots written count. A spec that cannot run
//   standalone may be replaced by --capture-script <path>, run as
//   `node <path> <output-dir>`, which must exit 0.
// - after: HEAD is built and served; the whole spec must pass.
// - Each phase must leave at least --min-shots (before: --min-before-shots)
//   .png files. The runner prints the screenshot directory of each phase and
//   exits non-zero on any failure.
//
// Isolation, as in the per-screen runners it generalizes
// - Each tree is exported with `git archive` into an owned temp directory,
//   installed offline from the npm cache and built with this Node 22 process.
// - Each build is served by a pinned node:22 container with no network at all.
// - Playwright runs in the Playwright image with the Node 22 binary from that
//   node:22 image mounted over its own node, sharing the app container's
//   network namespace: the app is reached on 127.0.0.1 and nothing else is.
// - Screenshots live in a temp directory outside git (kept, path printed).
//   Containers and the build temp directory are removed on exit, success or not.
import { spawnSync } from 'node:child_process'
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
import { USAGE, parseRunnerArgs } from './polish-runner-lib/args.mjs'
import { createDocker } from './polish-runner-lib/docker.mjs'

const NODE_IMAGE =
  'node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee'
const PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright:v1.65.0-noble'
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

if (process.versions.node.split('.')[0] !== '22') {
  console.error(`Node 22 is required, found ${process.version}`)
  process.exit(1)
}
let options
try {
  options = parseRunnerArgs(process.argv.slice(2))
} catch (error) {
  console.error(`${error.message}\n\n${USAGE}`)
  process.exit(2)
}
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

const { screen } = options
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const evidence = mkdtempSync(join(tmpdir(), `openfarm-${screen}-evidence-`))
const work = mkdtempSync(join(tmpdir(), `openfarm-${screen}-trees-`))
const id = `${screen}-evidence-${randomUUID()}`
const nodeBin = join(work, 'node22')
const commands = []
const cleanup = []
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  NUXT_TELEMETRY_DISABLED: '1',
  npm_config_update_notifier: 'false',
}
const { run, read, docker, containers } = createDocker({ root, env, commands })

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

// The shell steps run inside the Playwright container for one phase.
function phaseSteps(phase) {
  const shots = `/evidence/${phase}/shots`
  const cli = `node node_modules/@playwright/test/cli.js test -c /evidence/playwright-${phase}.config.mjs ${shellQuote(escapeRegex(options.spec))}`
  const steps = [`node -v > /evidence/${phase}-playwright-node.txt`]
  if (phase === 'after')
    steps.push(`${options.shotsEnv}=${shots} POLISH_CAPTURE=0 ${cli}`)
  else if (options.captureScript)
    steps.push(`node ${shellQuote(options.captureScript)} ${shots}`)
  else
    steps.push(
      `${options.shotsEnv}=${shots} POLISH_CAPTURE=1 ${cli} --grep ${shellQuote(options.captureGrep)} || echo 'capture-mode run exited non-zero: tolerated, only the screenshots count'`,
    )
  return steps.join('\n')
}

const manifest = {
  evidence,
  screen,
  startedAt: new Date().toISOString(),
  hostNode: process.version,
  images: { app: NODE_IMAGE, playwright: PLAYWRIGHT_IMAGE },
  options,
  commands,
  ownedResources: { tempDirs: [work, evidence], containers: [] },
  cleanup,
}
let failure
try {
  console.log(`Evidence: ${evidence}`)
  const baseline = read('git', ['rev-parse', `${options.baseline}^{commit}`])
  const after = read('git', ['rev-parse', 'HEAD'])
  if (
    spawnSync('git', ['merge-base', '--is-ancestor', baseline, after], {
      cwd: root,
    }).status !== 0
  )
    throw new Error('Baseline is not an ancestor of HEAD')
  for (const page of options.pages)
    if (
      spawnSync('git', ['diff', '--quiet', baseline, after, '--', page], {
        cwd: root,
      }).status === 0
    )
      throw new Error(`${page} is identical in baseline and HEAD`)
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
  for (const phase of ['before', 'after'])
    writeFileSync(
      join(evidence, `playwright-${phase}.config.mjs`),
      `export default ${JSON.stringify({
        testDir: '/work/tests/e2e',
        timeout: 30000,
        expect: { timeout: 5000 },
        workers: 1,
        reporter: [['list']],
        use: { baseURL: 'http://127.0.0.1:3000', headless: true },
        outputDir: `/evidence/${phase}/results`,
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
    try {
      playwright(phase, app, trees.after, phaseSteps(phase))
    } finally {
      docker(['rm', '-f', app])
      containers.delete(app)
      cleanup.push(`removed container ${app}`)
    }
    const shotsDir = join(evidence, phase, 'shots')
    const shots = existsSync(shotsDir)
      ? readdirSync(shotsDir).filter((name) => name.endsWith('.png'))
      : []
    const minimum =
      phase === 'before' ? options.minBeforeShots : options.minShots
    console.log(`${phase} screenshots (${shots.length}): ${shotsDir}`)
    if (shots.length < minimum)
      throw new Error(
        `${phase}: ${shots.length} shots, need at least ${minimum}`,
      )
    manifest[`${phase}Shots`] = shots.length
  }
  // Extra vitest runs for the screen (--unit), on this Node 22, offline. They
  // use an in-process mock API on 127.0.0.1 and the bundled Chromium; their
  // native bindings are host-platform, so they cannot run in the Linux
  // containers. No application service runs outside Docker.
  const vitest = 'node_modules/vitest/vitest.mjs'
  const unitEnv = { ...env, OPENFARM_BROWSER: 'bundled' }
  for (const unit of options.units)
    run('node', [vitest, 'run', ...unit], { cwd: trees.after, env: unitEnv })
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
if (failure) {
  console.error(failure.message)
  process.exit(1)
}
