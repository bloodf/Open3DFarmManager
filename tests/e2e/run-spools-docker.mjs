// Spoolman screen evidence, run entirely in Docker, offline, on the Node
// version pinned in .nvmrc (22).
//
//   node tests/e2e/run-spools-docker.mjs
//
// One `--rm` container, `--pull never --network none`, built from the committed
// tree (`git archive HEAD`, so uncommitted edits never leak into the evidence):
//
// 1. the locked node_modules are copied from the dependency image
//    (scripts/docker-base-image.mjs); nothing is installed per run.
// 2. before: the Spoolman page from BASELINE_SHA is put in place, the farm app
//    is built and the spec's screenshot test runs against it, so the "before"
//    screenshots are the genuine pre-change screen.
// 3. after: the committed page is restored, the app is rebuilt and the
//    evidence command runs unchanged:
//      npx playwright test tests/e2e/polish-spools.spec.ts
//    Its screenshot test always runs and asserts every capture.
//
// The Nuxt servers are the ones playwright.config.ts starts, inside the
// container on 127.0.0.1. Every /api call is mocked by the spec; no printer,
// Connector, Spoolman or external network is reachable.
//
// It never pulls: it needs the local image `openfarm-e2e-node<.nvmrc>` (that
// Node plus Playwright's browsers) and fails with provisioning instructions when
// it is missing. The dependency image is built from it once per lockfile.
//
// Everything writable is a tmpfs or lives in a run directory under
// ${XDG_CACHE_HOME:-~/.cache}/openfarm-docker/. Screenshots and manifest.json are
// copied to a temp folder outside the repository (printed at the end); the
// container and the run directory are always removed, also on SIGINT/SIGTERM.
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
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
import { screenEvidenceArgs } from './polish-runner-lib/docker.mjs'

// Last commit before the Spoolman polish.
const BASELINE_SHA = '5f356def2ae102d559af1800878802e5bbd5052c'
const PAGE = 'apps/farm/app/pages/spoolman.vue'
const SPEC = 'tests/e2e/polish-spools.spec.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const nodeVersion = readFileSync(join(root, '.nvmrc'), 'utf8').trim()
if (!/^22\.\d+\.\d+$/.test(nodeVersion))
  throw new Error(
    `.nvmrc must pin an exact Node 22 version, got "${nodeVersion}"`,
  )
const playwrightVersion = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).devDependencies['@playwright/test']
const sourceImage = browserNodeImage(root)
const container = `polish-spools-${randomUUID()}`

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

// Offline preflight: local state only, nothing is pulled or created.
if (
  sh('docker', ['image', 'inspect', sourceImage], { stdio: 'ignore' })
    .status !== 0
) {
  console.error(
    `Offline prerequisites missing: local Docker image "${sourceImage}".`,
  )
  console.error(`Provision it once, outside this runner (needs network):
  printf 'FROM node:${nodeVersion}-bookworm-slim AS node\\nFROM mcr.microsoft.com/playwright:v${playwrightVersion}-noble\\nCOPY --from=node /usr/local/bin/node /usr/local/bin/node\\n' | docker build -t ${sourceImage} -`)
  process.exit(2)
}
const image = ensureBaseImage({ projectDir: root, nodeImage: sourceImage })

const evidence = mkdtempSync(join(tmpdir(), 'openfarm-spools-evidence-'))
const runDir = createRunDir('polish-spools')
const scratch = join(runDir, 'scratch')
const output = join(runDir, 'evidence')
for (const dir of [
  scratch,
  join(runDir, 'work'),
  join(output, 'before'),
  join(output, 'after'),
])
  mkdirSync(dir, { recursive: true })
const cleanup = []
const manifest = {
  evidence,
  startedAt: new Date().toISOString(),
  image,
  imageId: out('docker', ['image', 'inspect', '-f', '{{.Id}}', image]),
  sourceImage,
  container,
  evidenceCommand: `npx playwright test ${SPEC}`,
  commands,
  ownedResources: { tempDirs: [evidence, runDir], containers: [container] },
  cleanup,
}

let status = 1
const lifecycle = createLifecycle()
// Finalizers run last-added first: keep the evidence, then drop the run.
lifecycle.finalizer(async () => {
  await removeRunDir(runDir, { image })
  cleanup.push(`removed ${runDir}`)
})
lifecycle.finalizer(() => {
  cpSync(output, evidence, { recursive: true })
  for (const phase of ['before', 'after'])
    manifest[`${phase}Screenshots`] = readdirSync(join(evidence, phase)).filter(
      (file) => file.endsWith('.png'),
    ).length
  manifest.finishedAt = new Date().toISOString()
  manifest.result = status === 0 ? 'passed' : `failed (${status})`
  writeFileSync(
    join(evidence, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  console.log(`Evidence kept at ${evidence}`)
})
lifecycle.installSignals()
try {
  const baseline = out('git', ['rev-parse', `${BASELINE_SHA}^{commit}`])
  const head = out('git', ['rev-parse', 'HEAD'])
  if (sh('git', ['merge-base', '--is-ancestor', baseline, head]).status !== 0)
    throw new Error('Baseline is not an ancestor of HEAD')
  if (sh('git', ['diff', '--quiet', baseline, head, '--', PAGE]).status === 0)
    throw new Error('Spoolman page is identical in baseline and HEAD')
  manifest.shas = { baseline, head }
  out('git', ['archive', '--format=tar', '-o', join(scratch, 'head.tar'), head])
  out('tar', ['-xf', join(scratch, 'head.tar'), '-C', join(runDir, 'work')])
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
mkdir -p "$HOME" && cd /work
${seedNodeModules('/work')}
node -v > /evidence/node-version.txt
echo '== before: baseline page ${baseline}'
cp ${PAGE} /tmp/after-page.vue
cp /scratch/before-page.vue ${PAGE}
${build}
POLISH_SPOOLS_SHOTS_DIR=/evidence/before npx playwright test ${SPEC} --grep 'screenshots of real screen states' --output /tmp/before-results
echo '== after: ${head}'
cp /tmp/after-page.vue ${PAGE}
${build}
POLISH_SPOOLS_SHOTS_DIR=/evidence/after npx playwright test ${SPEC} --output /tmp/after-results`
  commands.push(`docker run ${container}`)
  const run = await lifecycle.run(
    screenEvidenceArgs({ name: container, image, runDir, script }),
    { inherit: true },
  )
  status = run.status
} catch (error) {
  console.error(error)
  status = 1
} finally {
  await lifecycle.cleanup()
}
process.exit(status)
