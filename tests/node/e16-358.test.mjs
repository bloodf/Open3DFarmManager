import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'

const env = {
  ...process.env,
  PATH: '/usr/bin:/bin',
  TMPDIR: realpathSync(tmpdir()),
}
delete env.OPENFARM_SIM
delete env.OPENFARM_PG
delete env.NODE_TEST_CONTEXT
const cwd = new URL('../../', import.meta.url)

function node(...args) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}

for (const [cli, proof] of [
  ['cli', /SIM_SMOKE_READY: sv06[\s\S]*SIM_SMOKE_READY: u1/],
  ['seed-cli', /spools: 6/],
  ['full-cli', /SIM_FULL_OK/],
  ['rtsp-cli', /SIM_RTSP_OK/],
]) {
  test(`${cli} starts loopback simulators with the mode unset`, () => {
    assert.match(node(`packages/sim-tools/src/${cli}.ts`), proof)
  })
}

for (const diagnostic of [
  'klipper-diagnostics',
  'sim-profile-diagnostics',
  'simulator-identify-diagnostic',
]) {
  test(`${diagnostic} requires the container mode`, () => {
    assert.match(node(`scripts/${diagnostic}.mjs`), /Docker mode only/)
  })
}

test('canonical temp paths do not mask startup log redaction and cleanup', () => {
  assert.match(
    node(
      '--test',
      '--test-name-pattern=bounds startup output and reports log failures',
      'tests/node/simulator-identify-diagnostic.test.ts',
    ),
    /pass 1/,
  )
})

test('KobraLink integration exercises the loopback protocol suite by default', () => {
  assert.match(node('scripts/test-kobralink-integration.mjs'), /pass 7/)
})

test('rtc-farm all-mode summary defers container-only rows outside docker mode', () => {
  assert.match(node('--test', 'tests/node/rtc-farm-all-mode.test.ts'), /fail 0/)
})
