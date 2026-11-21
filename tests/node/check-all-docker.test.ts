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
  resourceNames: (id: string) => { id: string; container: string }
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
  assert.match(result.stdout, /missing npm cache volume fails closed/)
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
