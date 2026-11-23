// Printer detail screen evidence, run entirely in Docker, offline, on the Node
// version pinned in .nvmrc (22).
//
//   node tests/e2e/run-printer-docker.mjs
//
// One container, `--pull never --network none`, built from the committed tree
// (`git archive HEAD`, so uncommitted edits never leak into the evidence):
//
// 1. `npm ci --offline` from the local npm cache volume.
// 2. before: the printer detail page from BASELINE_SHA is put in place, the farm app
//    is built and the spec's screenshot test runs against it, so the "before"
//    screenshots are the genuine pre-change screen.
// 3. after: the committed page is restored, the app is rebuilt and the
//    evidence command runs unchanged:
//      npx playwright test tests/e2e/polish-printer.spec.ts
//    It runs every axe, layout, focus and network assertion of the spec and
//    its screenshot test, which asserts every capture.
//
// The Nuxt servers are the ones playwright.config.ts starts, inside the
// container on 127.0.0.1. Every /api call is mocked by the spec; no printer,
// Connector or external network is reachable, and no browser device key is
// registered, so no command can reach a printer.
//
// It never builds an image, primes a cache or pulls: it needs the local image
// `openfarm-e2e-node<.nvmrc>` (that Node plus Playwright's browsers) and the
// local volume `openfarm-e2e-npm-cache`, and fails with provisioning
// instructions when either is missing.
//
// Screenshots and manifest.json stay in a temp folder outside the repository
// (printed at the end). The container and scratch folder are always removed.
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Last commit before the printer detail polish (a84350b4).
const BASELINE_SHA = 'e45972578f03bc70034760dd46f03f0e789efacf'
const PAGE = 'apps/farm/app/pages/impressoras/[printerKey].vue'
const SPEC = 'tests/e2e/polish-printer.spec.ts'
const CACHE_VOLUME = 'openfarm-e2e-npm-cache'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const nodeVersion = readFileSync(join(root, '.nvmrc'), 'utf8').trim()
if (!/^22\.\d+\.\d+$/.test(nodeVersion))
  throw new Error(
    `.nvmrc must pin an exact Node 22 version, got "${nodeVersion}"`,
  )
const playwrightVersion = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).devDependencies['@playwright/test']
const image = `openfarm-e2e-node${nodeVersion}`
const container = `polish-printer-${randomUUID()}`

const commands = []
function sh(command, args, options = {}) {
  commands.push([command, ...args].join(' '))
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  })
  if (result.error) throw result.error
  return result
}
const out = (command, args) => {
  const result = sh(command, args)
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
  return result.stdout.trim()
}

// Offline preflight: local state only, nothing is built, pulled or created.
const missing = []
if (sh('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0)
  missing.push(`local Docker image "${image}"`)
if (
  sh('docker', ['volume', 'inspect', CACHE_VOLUME], { stdio: 'ignore' })
    .status !== 0
)
  missing.push(`local Docker volume "${CACHE_VOLUME}" (npm cache)`)
if (missing.length) {
  console.error(`Offline prerequisites missing: ${missing.join(' and ')}.`)
  console.error(`Provision them once, outside this runner (needs network):
  printf 'FROM node:${nodeVersion}-bookworm-slim AS node\\nFROM mcr.microsoft.com/playwright:v${playwrightVersion}-noble\\nCOPY --from=node /usr/local/bin/node /usr/local/bin/node\\n' | docker build -t ${image} -
  docker run --rm -v "$PWD":/src:ro -v ${CACHE_VOLUME}:/npm-cache ${image} bash -c 'mkdir /work && tar -C /src --exclude=./node_modules --exclude=./.git -cf - . | tar -C /work -xf - && cd /work && npm ci --cache /npm-cache --ignore-scripts --no-audit --no-fund'`)
  process.exit(2)
}

const evidence = mkdtempSync(join(tmpdir(), 'openfarm-printer-evidence-'))
const scratch = mkdtempSync(join(tmpdir(), 'openfarm-printer-scratch-'))
mkdirSync(join(evidence, 'before'))
mkdirSync(join(evidence, 'after'))
const cleanup = []
const manifest = {
  evidence,
  startedAt: new Date().toISOString(),
  image,
  imageId: out('docker', ['image', 'inspect', '-f', '{{.Id}}', image]),
  cacheVolume: CACHE_VOLUME,
  container,
  evidenceCommand: `npx playwright test ${SPEC}`,
  commands,
  ownedResources: { tempDirs: [evidence, scratch], containers: [container] },
  cleanup,
}

let status = 1
try {
  const baseline = out('git', ['rev-parse', `${BASELINE_SHA}^{commit}`])
  const head = out('git', ['rev-parse', 'HEAD'])
  if (sh('git', ['merge-base', '--is-ancestor', baseline, head]).status !== 0)
    throw new Error('Baseline is not an ancestor of HEAD')
  if (sh('git', ['diff', '--quiet', baseline, head, '--', PAGE]).status === 0)
    throw new Error('Printer detail page is identical in baseline and HEAD')
  manifest.shas = { baseline, head }
  out('git', ['archive', '--format=tar', '-o', join(scratch, 'head.tar'), head])
  writeFileSync(
    join(scratch, 'before-page.vue'),
    out('git', ['show', `${baseline}:${PAGE}`]) + '\n',
  )

  const build = `rm -rf apps/farm/.nuxt apps/farm/.output
npm run build -w @open3dfarmmanager/farm > /tmp/build.log 2>&1 || { tail -n 80 /tmp/build.log; exit 1; }`
  const script = `set -e
[ "$(node -v)" = "v${nodeVersion}" ] || { echo "Node $(node -v), want v${nodeVersion}"; exit 1; }
[ -f /.dockerenv ] || { echo 'not inside Docker; refusing to run'; exit 1; }
node -e "fetch('https://registry.npmjs.org/').then(() => process.exit(1), () => {})" || { echo 'network is reachable; refusing to run'; exit 1; }
mkdir /work && tar -C /work -xf /scratch/head.tar && cd /work
npm ci --offline --cache /npm-cache --ignore-scripts --no-audit --no-fund > /tmp/npm.log 2>&1 || { tail -n 40 /tmp/npm.log; echo 'npm ci --offline failed: re-prime the cache volume outside the runner'; exit 1; }
node -v > /evidence/node-version.txt
echo '== before: baseline page ${baseline}'
cp '${PAGE}' /tmp/after-page.vue
cp /scratch/before-page.vue '${PAGE}'
${build}
POLISH_PRINTER_SHOTS_DIR=/evidence/before npx playwright test ${SPEC} --grep 'screenshots of real screen states' --output /tmp/before-results
echo '== after: ${head}'
cp /tmp/after-page.vue '${PAGE}'
${build}
POLISH_PRINTER_SHOTS_DIR=/evidence/after npx playwright test ${SPEC} --output /tmp/after-results`
  const run = sh(
    'docker',
    [
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--shm-size=1g',
      `--name=${container}`,
      '-e',
      'CI=1',
      '-e',
      'OPENFARM_BROWSER=bundled',
      '-e',
      'NUXT_TELEMETRY_DISABLED=1',
      '-e',
      'DO_NOT_TRACK=1',
      '-v',
      `${scratch}:/scratch:ro`,
      '-v',
      `${CACHE_VOLUME}:/npm-cache`,
      '-v',
      `${evidence}:/evidence`,
      image,
      'bash',
      '-c',
      script,
    ],
    { stdio: 'inherit' },
  )
  status = run.status ?? 1
  for (const phase of ['before', 'after'])
    manifest[`${phase}Screenshots`] = spawnSync('ls', [join(evidence, phase)], {
      encoding: 'utf8',
    })
      .stdout.split('\n')
      .filter((file) => file.endsWith('.png')).length
} catch (error) {
  console.error(error)
  status = 1
} finally {
  if (sh('docker', ['rm', '-f', container], { stdio: 'ignore' }).status === 0)
    cleanup.push(`removed container ${container}`)
  else cleanup.push(`container ${container} already removed (--rm)`)
  rmSync(scratch, { recursive: true, force: true })
  cleanup.push(`removed ${scratch}`)
  manifest.finishedAt = new Date().toISOString()
  manifest.result = status === 0 ? 'passed' : `failed (${status})`
  writeFileSync(
    join(evidence, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  console.log(`Evidence kept at ${evidence}`)
}
process.exit(status)
