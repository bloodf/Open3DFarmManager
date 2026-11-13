// SPDX-License-Identifier: MIT
// Run only after the isolated, owned Compose service has been started.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createKobraLinkClient } from '../packages/connector/src/kobralink/client.ts'

assert.equal(
  process.env.DOCKER_CONTEXT,
  'colima-openfarm-kobralink-togiej',
  'Explicit owned context required',
)
assert.equal(
  process.env.KOBRALINK_INTEGRATION_OWNED,
  'yes',
  'Exclusive custody required',
)
// Validate the unchanged accepted recipe before contacting the service.
// KOBRALINK_SRC must identify the verified external checkout.
execFileSync(
  'docker',
  [
    '--context',
    process.env.DOCKER_CONTEXT,
    'compose',
    '-f',
    new URL('../infra/kobralink/docker-compose.yml', import.meta.url).pathname,
    'config',
    '--quiet',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: 'openfarm-kobralink-integration',
      KOBRALINK_IMAGE: 'openfarm-kobralink-togiej/kobralink:5a5e5d9',
      KOBRALINK_MGMT_PORT: '17100',
      KOBRALINK_AUTH_SECRET: randomBytes(32).toString('hex'),
    },
  },
)
const origin = 'http://127.0.0.1:17100'
const client = createKobraLinkClient({ origin, allowedOrigins: [origin] })
const input = {
  ownership: 'fresh_owned',
  mode: 'signup',
  name: 'Synthetic integration',
  email: `${randomBytes(12).toString('hex')}@fixture.invalid`,
  password: randomBytes(24).toString('hex'),
}
const passed = []
try {
  assert.equal((await client.setupStatus()).needsSetup, true)
  passed.push('fresh setup')
  await client.authenticate(input)
  passed.push('signup')
  assert.deepEqual(await client.listPrinters(), [])
  passed.push('authenticated empty inventory')
  client.clearSession()
  await client.authenticate({ ...input, mode: 'signin' })
  assert.deepEqual(await client.listPrinters(), [])
  passed.push('signin and session reuse')
  console.log(
    JSON.stringify({
      status: 'passed',
      passed,
      scope:
        'authentication preflight only; device and runtime scenarios require subsequent qualification',
    }),
  )
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      passed,
      error: error instanceof Error ? error.message : 'unknown',
    }),
  )
  process.exitCode = 1
} finally {
  client.clearSession()
}
