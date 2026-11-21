// Farm screen evidence runner.
//
// Builds the farm app twice, from the pre-polish base commit and from this
// checkout, serves each build from a Node 22 container on an internal Docker
// network and drives the mocked Playwright specs against it. The runner never
// pulls images and never reaches the network: the container network is
// `--internal`, the install is offline and every spec routes /api calls to
// in-test mocks. No physical printer is involved.
//
// Everything (app build, containers, test runner) runs on Node 22. The runner
// refuses to start on any other major version and checks each container.
//
// Output (screenshots, axe JSON, reports, manifest.json) goes to a directory
// outside the repository, printed at start and kept after the run.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const NODE_MAJOR = '22'
// Node 22.23.5 (Debian bookworm), pinned by digest and never pulled.
const NODE_IMAGE =
  process.env.OPENFARM_NODE22_IMAGE ??
  'node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee'
// Parent of the farm screen polish commit (86df641b): the "before" code.
const BASELINE_SHA = 'e45972578f03bc70034760dd46f03f0e789efacf'
const PAGE = 'apps/farm/app/pages/farm.vue'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const evidence = resolve(
  process.env.OPENFARM_EVIDENCE_DIR ??
    mkdtempSync(join(tmpdir(), 'openfarm-farm-evidence-')),
)
if (evidence === root || evidence.startsWith(root + sep))
  throw new Error(`Evidence directory must be outside the repository: ${root}`)
mkdirSync(evidence, { recursive: true })

const id = `farm-evidence-${randomUUID().slice(0, 8)}`
const network = `${id}-network`
const baseSource = join(evidence, 'base-source')
const playwrightBin = join(root, 'node_modules/.bin/playwright')

const manifest = {
  runner: 'tests/e2e/run-farm-docker.mjs',
  startedAt: new Date().toISOString(),
  baselineSha: BASELINE_SHA,
  afterSha: '',
  pageBlob: { before: '', after: '' },
  node: { host: process.versions.node, containers: {}, image: NODE_IMAGE },
  evidenceDir: evidence,
  commands: [],
  results: {},
  files: {},
  ownedResources: {
    network,
    containers: [],
    worktree: baseSource,
    evidenceDir: evidence,
    generatedPaths: [],
  },
  cleanup: [],
}

const record = (command, args) =>
  manifest.commands.push([command, ...args].join(' '))
const run = (command, args, options = {}) => {
  record(command, args)
  return execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  })
}
const capture = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  }).trim()
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function requireNode22() {
  if (!process.versions.node.startsWith(`${NODE_MAJOR}.`))
    throw new Error(
      `Farm evidence requires Node ${NODE_MAJOR}; this is ${process.versions.node}.`,
    )
}

function requireImage() {
  try {
    manifest.node.imageId = capture('docker', [
      'image',
      'inspect',
      NODE_IMAGE,
      '--format',
      '{{.Id}}',
    ])
  } catch {
    throw new Error(
      `Image ${NODE_IMAGE} is not present locally and this runner never pulls.`,
    )
  }
}

// Serve one built .output directory from a Node 22 container. Returns the
// loopback URL and a cleanup function.
async function serve(label, output) {
  const container = `${id}-${label}-app`
  const proxy = `${id}-${label}-proxy`
  manifest.ownedResources.containers.push(container, proxy)
  const created = []
  const cleanup = () => {
    for (const name of created.reverse()) {
      const result = spawnSync('docker', ['rm', '-f', name], {
        encoding: 'utf8',
      })
      manifest.cleanup.push(`docker rm -f ${name}: exit ${result.status}`)
    }
  }
  try {
    run('docker', [
      'create',
      '--pull=never',
      '--name',
      container,
      '--network',
      network,
      '-v',
      `${output}:/app:ro`,
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
    created.push(container)
    run('docker', ['start', container])
    run('docker', [
      'create',
      '--pull=never',
      '--name',
      proxy,
      '-p',
      '127.0.0.1::3000',
      NODE_IMAGE,
      'node',
      '-e',
      `const net = require('node:net'); net.createServer(s => { const upstream = net.connect(3000, '${container}'); s.pipe(upstream).pipe(s); upstream.on('error', () => s.destroy()); s.on('error', () => upstream.destroy()) }).listen(3000, '0.0.0.0')`,
    ])
    created.push(proxy)
    run('docker', ['network', 'connect', network, proxy])
    run('docker', ['start', proxy])
    for (const name of [container, proxy]) {
      const version = capture('docker', ['exec', name, 'node', '-v'])
      manifest.node.containers[name] = version
      if (!version.startsWith(`v${NODE_MAJOR}.`))
        throw new Error(`${name} runs Node ${version}, expected ${NODE_MAJOR}.`)
    }
    let port = 0
    for (let attempt = 0; attempt < 30 && !port; attempt++) {
      const result = spawnSync('docker', ['port', proxy, '3000/tcp'], {
        encoding: 'utf8',
      })
      port = Number(result.stdout.trim().split(':').pop()) || 0
      if (!port) await sleep(1000)
    }
    if (!port) {
      run('docker', ['logs', container])
      throw new Error('Docker did not publish the application port')
    }
    const url = `http://127.0.0.1:${port}`
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        if ((await fetch(`${url}/healthz`)).ok) return { url, cleanup }
      } catch {}
      await sleep(1000)
    }
    run('docker', ['logs', container])
    throw new Error('Docker application did not become healthy')
  } catch (error) {
    cleanup()
    throw error
  }
}

function build(label, source) {
  console.log(`Building ${label} from ${source}`)
  run('npm', ['run', 'build', '-w', '@open3dfarmmanager/farm'], {
    cwd: source,
    env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' },
  })
  return join(source, 'apps/farm/.output')
}

function playwright(label, url, spec, shots) {
  const dir = join(evidence, `${label}-playwright`)
  mkdirSync(shots, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const config = join(dir, 'playwright.config.mjs')
  const report = join(dir, 'report.json')
  const use = { baseURL: url, headless: true }
  if (process.env.OPENFARM_CHROME_PATH?.trim())
    use.launchOptions = { executablePath: process.env.OPENFARM_CHROME_PATH }
  else use.channel = 'chrome'
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      testDir: join(root, 'tests/e2e'),
      timeout: 30000,
      workers: 1,
      reporter: [['list'], ['json', { outputFile: report }]],
      use,
      outputDir: join(dir, 'results'),
    })}\n`,
  )
  const args = ['test', '-c', config, spec]
  record(playwrightBin, args)
  const result = spawnSync(playwrightBin, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, POLISH_FARM_SHOTS_DIR: shots },
  })
  if (result.error) throw result.error
  manifest.results[label] = { spec, exit: result.status, report, shots }
  if (result.status !== 0)
    throw new Error(`Playwright ${label} failed: ${result.status}`)
}

function checksum(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (lstatSync(path).isDirectory()) continue
    manifest.files[relative(evidence, path)] = createHash('sha256')
      .update(readFileSync(path))
      .digest('hex')
  }
}

function removePath(path) {
  if (!existsSync(path) && !isLink(path)) return
  if (isLink(path)) unlinkSync(path)
  else rmSync(path, { recursive: true, force: true })
  manifest.cleanup.push(`removed ${path}`)
}

const generatedNames = [
  'apps/farm/.nuxt',
  'apps/farm/.output',
  'apps/farm/node_modules',
]
// Only remove generated paths this run created.
const ownedGenerated = generatedNames.filter(
  (name) => !existsSync(join(root, name)),
)
let installed = false
let networkCreated = false
let worktreeCreated = false
let failure
try {
  requireNode22()
  requireImage()
  console.log(`Evidence: ${evidence}`)
  console.log(`Node ${process.versions.node}, app image ${NODE_IMAGE}`)
  manifest.afterSha = capture('git', ['rev-parse', 'HEAD'])
  manifest.pageBlob.before = capture('git', [
    'rev-parse',
    `${BASELINE_SHA}:${PAGE}`,
  ])
  manifest.pageBlob.after = capture('git', ['rev-parse', `HEAD:${PAGE}`])
  if (manifest.pageBlob.before === manifest.pageBlob.after)
    throw new Error('Baseline and current farm page are identical.')
  manifest.ownedResources.generatedPaths = ownedGenerated.map((name) =>
    join(root, name),
  )
  if (!existsSync(join(root, 'node_modules/.bin/playwright'))) {
    installed = true
    manifest.ownedResources.generatedPaths.push(join(root, 'node_modules'))
    run('npm', ['ci', '--offline', '--ignore-scripts'])
  }
  run('docker', ['network', 'create', '--internal', network])
  networkCreated = true

  // Before: the pre-polish base in a detached worktree. Dependencies are the
  // same as in this checkout, so it reuses node_modules.
  run('git', ['worktree', 'add', '--detach', baseSource, BASELINE_SHA])
  worktreeCreated = true
  symlinkSync(join(root, 'node_modules'), join(baseSource, 'node_modules'))
  const beforeOutput = build('before', baseSource)
  const before = await serve('before', beforeOutput)
  try {
    playwright(
      'before',
      before.url,
      'farm-evidence-capture.spec.ts',
      join(evidence, 'before'),
    )
  } finally {
    before.cleanup()
  }

  // After: this checkout. The capture spec records the same states as the
  // before run; the asserting spec (axe included) must pass.
  const afterOutput = build('after', root)
  const after = await serve('after', afterOutput)
  try {
    playwright(
      'after',
      after.url,
      'farm-evidence-capture.spec.ts',
      join(evidence, 'after'),
    )
    playwright(
      'after-assertions',
      after.url,
      'polish-farm.spec.ts',
      join(evidence, 'after-assertions'),
    )
  } finally {
    after.cleanup()
  }
  for (const phase of ['before', 'after', 'after-assertions'])
    checksum(join(evidence, phase))
} catch (error) {
  failure = error
} finally {
  if (networkCreated) {
    const result = spawnSync('docker', ['network', 'rm', network], {
      encoding: 'utf8',
    })
    manifest.cleanup.push(`docker network rm ${network}: exit ${result.status}`)
  }
  if (worktreeCreated) {
    for (const name of [...generatedNames, 'node_modules'])
      removePath(join(baseSource, name))
    const result = spawnSync('git', ['worktree', 'remove', baseSource], {
      cwd: root,
      encoding: 'utf8',
    })
    manifest.cleanup.push(
      `git worktree remove ${baseSource}: exit ${result.status} ${result.stderr.trim()}`,
    )
  }
  for (const name of ownedGenerated) removePath(join(root, name))
  if (installed) removePath(join(root, 'node_modules'))
  manifest.finishedAt = new Date().toISOString()
  manifest.failure = failure ? String(failure.message ?? failure) : null
  writeFileSync(
    join(evidence, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  console.log(`Manifest: ${join(evidence, 'manifest.json')}`)
}
if (failure) throw failure
