import assert from 'node:assert/strict'
import { startVitest } from 'vitest/node'

const fixtureUrl = new URL(process.env.SPOOL_BINDING_FIXTURE_URL ?? '')
assert.equal(process.env.SPOOL_BINDING_FIXTURE_ADMITTED, 'yes')
assert.equal(fixtureUrl.protocol, 'postgresql:')
assert.equal(fixtureUrl.hostname, '127.0.0.1')
assert.equal(fixtureUrl.pathname, '/fixture')
assert.match(process.env.SPOOL_BINDING_FIXTURE_SYSTEM_ID ?? '', /^\d+$/)

const vitest = await startVitest(
  'test',
  ['tests/unit/integration-spool-identity-services.test.ts'],
  { run: true },
)
assert.ok(vitest, 'Spool binding suite did not start')
await vitest.close()
