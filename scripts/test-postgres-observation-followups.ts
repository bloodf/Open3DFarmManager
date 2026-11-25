// Spool observation lock order, integration-role grants and alert skew flags on
// the runner's disposable PostgreSQL fixture.
import assert from 'node:assert/strict'
import { startVitest } from 'vitest/node'

const fixtureUrl = new URL(process.env.OBSERVATION_FOLLOWUPS_FIXTURE_URL ?? '')
assert.equal(process.env.OBSERVATION_FOLLOWUPS_FIXTURE_ADMITTED, 'yes')
assert.equal(fixtureUrl.protocol, 'postgresql:')
assert.equal(fixtureUrl.hostname, '127.0.0.1')

const vitest = await startVitest(
  'test',
  ['tests/unit/rv-930b-postgres.test.ts'],
  { run: true },
)
assert.ok(vitest, 'Observation follow-ups suite did not start')
const states = vitest.state
  .getTestModules()
  .flatMap((module) => [...module.children.allTests()])
  .map((test) => test.result().state)
await vitest.close()
// A skipped suite would otherwise pass without touching PostgreSQL.
assert.ok(states.length > 0, 'No observation follow-up test ran')
assert.deepEqual([...new Set(states)], ['passed'])
console.log(JSON.stringify({ result: 'passed', tests: states.length }))
