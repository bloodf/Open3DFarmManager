// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(
  new URL('../../scripts/check-all-docker.mjs', import.meta.url),
)

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
