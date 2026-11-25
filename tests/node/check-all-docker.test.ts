// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(
  new URL('../../scripts/check-all-docker.mjs', import.meta.url),
)

type RunnerModule = {
  resolveConfig: (env: Record<string, string>) => { nodeImage: string }
  resourceNames: (id: string) => {
    id: string
    container: string
    runDir: string
  }
  planCalls: (cfg: unknown, names: unknown) => string[][]
  execPlan: (names: unknown) => { label: string; args: string[] }[]
  findPlanProblems: (calls: string[][]) => string[]
}
type BrowserModule = {
  CHROME_WRAPPER: string
  PREPARE_BROWSER: string
  browserMount: (nodeImage: string) => string
}

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  })

test('check-all-docker --self-test proves command construction and fail-closed prerequisites without Docker', () => {
  // A missing Docker binary shows the self-test never starts a service or calls Docker.
  const result = run(['--self-test'], {
    OPENFARM_GATE_DOCKER: '/nonexistent/docker',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(
    result.stdout,
    /self-test passed \(\d+ checks, no service started\)/,
  )
  assert.match(result.stdout, /missing PostgreSQL image fails closed/)
  assert.match(result.stdout, /an existing dependency image is reused/)
  assert.match(result.stdout, /missing dependency source image fails closed/)
  assert.doesNotMatch(result.stdout, /^FAIL/m)
})

test('check-all-docker fails closed when Docker is unavailable', () => {
  const result = run([], { OPENFARM_GATE_DOCKER: '/nonexistent/docker' })
  assert.equal(result.status, 3)
  assert.match(result.stderr, /Docker CLI .* not found/)
  assert.doesNotMatch(result.stdout, /step:/)
})

test('check-all-docker rejects unknown arguments', () => {
  const result = run(['--skip-tests'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Unknown argument: --skip-tests/)
})

test('check-all-docker supplies the Node image Chromium to the unmodified check:all', async () => {
  const runner = (await import(
    new URL('../../scripts/check-all-docker.mjs', import.meta.url).href
  )) as RunnerModule
  const browser = (await import(
    new URL('../../scripts/check-all-docker-browser.mjs', import.meta.url).href
  )) as BrowserModule
  const cfg = runner.resolveConfig({})
  const names = runner.resourceNames('browser-test')
  const calls = runner.planCalls(cfg, names)
  const plan = runner.execPlan(names)
  const labels = plan.map((step: { label: string }) => step.label)
  const create = calls[0] ?? []

  // Read-only image mount of the Node image's Playwright browsers; no download.
  assert.ok(create.includes(browser.browserMount(cfg.nodeImage)))
  assert.match(
    browser.browserMount(cfg.nodeImage),
    /^type=image,source=openfarm-e2e-node22\.23\.5:latest,destination=\/opt\/ms-playwright,image-subpath=ms-playwright,readonly$/,
  )
  // Prepared after HOME exists and before the gate, which stays verbatim.
  assert.ok(
    labels.indexOf('prepare offline browser') > labels.indexOf('prepare home'),
  )
  assert.ok(
    labels.indexOf('prepare offline browser') <
      labels.indexOf('npm run check:all'),
  )
  const gate = calls.at(-1) ?? []
  assert.deepEqual(gate.slice(-3), ['npm', 'run', 'check:all'])
  assert.ok(gate.includes(`OPENFARM_CHROME_PATH=${browser.CHROME_WRAPPER}`))
  assert.ok(
    !gate.some((arg: string) =>
      /OPENFARM_BROWSER=|--skip|--grep|--exclude/.test(arg),
    ),
  )
  assert.deepEqual(runner.findPlanProblems(calls), [])

  // Fails closed, adds only libraries the container lacks, never fetches.
  const script = browser.PREPARE_BROWSER
  assert.match(script, /^set -eu\n/)
  assert.match(script, /no Playwright Chromium/)
  assert.match(
    script,
    /\[ -e "\/usr\/lib\/\$triplet\/\$name" \] \|\| \[ -e "\/lib\/\$triplet\/\$name" \]/,
  )
  assert.match(script, /ldd "\$chrome"/)
  assert.doesNotMatch(script, /\b(curl|wget|apt-get|npx|playwright install)\b/)

  // The safety checker refuses a plan that drops the browser step.
  const withoutBrowser = calls.filter(
    (call: string[]) => call.at(-1) !== browser.PREPARE_BROWSER,
  )
  assert.ok(
    runner
      .findPlanProblems(withoutBrowser)
      .some((p: string) => /OPENFARM_CHROME_PATH/.test(p)),
  )
})

type RuntimeModule = {
  PYTHON_BIN_DIR: string
  PREPARE_PYTHON: string
  SCRATCH_DIR: string
  MIN_SCRATCH_BYTES: number
  PREPARE_SCRATCH: string
  scratchMount: (runDir: string) => string
}

test('check-all-docker supplies python3 with the Node image libraries it needs', async () => {
  const runner = (await import(
    new URL('../../scripts/check-all-docker.mjs', import.meta.url).href
  )) as RunnerModule
  const runtime = (await import(
    new URL('../../scripts/check-all-docker-runtime.mjs', import.meta.url).href
  )) as RuntimeModule
  const names = runner.resourceNames('python-test')
  const calls = runner.planCalls(runner.resolveConfig({}), names)
  const labels = runner.execPlan(names).map((step) => step.label)
  const gate = calls.at(-1) ?? []
  const path = gate.find((arg) => arg.startsWith('PATH='))?.slice(5) ?? ''
  const dirs = path.split(':')

  // The wrapper directory wins over the Node image's raw /usr/bin.
  assert.ok(dirs.indexOf(runtime.PYTHON_BIN_DIR) >= 0)
  assert.ok(
    dirs.indexOf(runtime.PYTHON_BIN_DIR) < dirs.indexOf('/opt/gate-tools/bin'),
  )
  assert.ok(
    labels.indexOf('prepare python runtime') > labels.indexOf('prepare home'),
  )
  assert.ok(
    labels.indexOf('prepare python runtime') <
      labels.indexOf('npm run check:all'),
  )
  // Only libraries the container lacks are added; glibc is never shadowed;
  // pyexpat (libexpat.so.1) is proven to load before the gate starts.
  const script = runtime.PREPARE_PYTHON
  assert.match(script, /^set -eu\n/)
  assert.match(
    script,
    /\[ -e "\/usr\/lib\/\$triplet\/\$name" \] \|\| \[ -e "\/lib\/\$triplet\/\$name" \]/,
  )
  assert.match(script, /ldd/)
  assert.match(script, /import pyexpat/)
  assert.doesNotMatch(script, /\b(curl|wget|apt-get|pip|npx)\b/)
  assert.ok(calls.some((call) => call.at(-1) === script))
  assert.ok(
    runner
      .findPlanProblems(calls.filter((call) => call.at(-1) !== script))
      .some((p) => /python3/.test(p)),
  )
})

test('check-all-docker gives /tmp a run-owned scratch directory with at least 10 GiB free', async () => {
  const runner = (await import(
    new URL('../../scripts/check-all-docker.mjs', import.meta.url).href
  )) as RunnerModule
  const runtime = (await import(
    new URL('../../scripts/check-all-docker-runtime.mjs', import.meta.url).href
  )) as RuntimeModule
  const names = runner.resourceNames('scratch-test')
  const calls = runner.planCalls(runner.resolveConfig({}), names)
  const create = calls[0] ?? []
  const labels = runner.execPlan(names).map((step) => step.label)

  // A bind of this run's directory: owned by the run, removed with it.
  const scratch = runtime.scratchMount(names.runDir)
  assert.equal(scratch, `type=bind,source=${names.runDir}/tmp,destination=/tmp`)
  assert.match(names.runDir, /\/openfarm-docker\/check-all-scratch-test$/)
  assert.ok(create.includes(scratch))
  assert.ok(!create.some((arg) => /^\/tmp:/.test(arg)), 'no /tmp tmpfs')
  // The rehearsal asserts > 10 GiB; the runner checks it up front, fail-closed.
  assert.ok(runtime.MIN_SCRATCH_BYTES > 10 * 1024 ** 3)
  assert.match(runtime.PREPARE_SCRATCH, /^set -eu\n/)
  assert.match(runtime.PREPARE_SCRATCH, /df -Pk/)
  assert.ok(
    labels.indexOf('check scratch space') < labels.indexOf('prepare home'),
  )
  assert.deepEqual(runner.findPlanProblems(calls), [])

  // The checker refuses a named, anonymous, foreign or missing scratch mount.
  const swap = (mount: string) =>
    calls.map((call, i) =>
      i === 0 ? call.map((arg) => (arg === scratch ? mount : arg)) : call,
    )
  for (const tainted of [
    swap('type=volume,source=shared,destination=/tmp'),
    swap('type=volume,destination=/tmp'),
    swap('type=bind,source=/tmp,destination=/tmp'),
    swap(`type=bind,source=${names.runDir}/../other/tmp,destination=/tmp`),
    calls.map((call, i) =>
      i === 0
        ? call.filter((arg, j) => arg !== scratch && call[j + 1] !== scratch)
        : call,
    ),
  ])
    assert.ok(
      runner.findPlanProblems(tainted).some((p) => /scratch/.test(p)),
      JSON.stringify(tainted[0]),
    )
})
