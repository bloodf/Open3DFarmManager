import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  outagePauseScenarioNames,
  runOutagePauseScenarios,
} from '../helpers/connector-outage-pause.ts'

test('outage pause scenarios cover expiry, confirmed recovery and durable audit ordering', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'outage-pause-scenarios-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  assert.deepEqual(outagePauseScenarioNames, [
    '7-pause-authority-expires-during-server-outage',
    '8-pause-authority-recovers-after-confirmation',
    '9-pause-authority-audit-survives-restart-in-order',
  ])
  const { scenarios } = await runOutagePauseScenarios(directory)
  assert.deepEqual(
    scenarios.map((scenario) => scenario.name),
    outagePauseScenarioNames,
  )
  assert.deepEqual(
    scenarios.map((scenario) => scenario.result),
    ['passed', 'passed', 'passed'],
  )
  assert.equal(scenarios[0]?.authorityFresh, false)
  assert.equal(scenarios[1]?.authorityFresh, true)
  assert.equal(scenarios[2]?.ordered, true)
})
