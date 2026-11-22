import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allAcceptanceRows,
  buildAcceptanceSummary,
  deferredAcceptanceRows,
  HARDWARE_ACCEPTANCE_DEFERRED,
  NETWORK_FAULT_PROFILES,
  parseLastJson,
  rowPassed,
  runnableAcceptanceRows,
} from '../../scripts/rtc-farm-all-mode.ts'

test('all mode selects every registered RTC farm row, including opt-in resource rows', () => {
  const rows = allAcceptanceRows()
  assert.ok(rows.includes('farm-page-camera'))
  assert.ok(rows.includes('farm-page-simulator-inventory'))
  assert.ok(rows.includes('farm-page-printing-pause'))
  assert.equal(new Set(rows).size, rows.length)
  assert.deepEqual(runnableAcceptanceRows({ OPENFARM_SIM: 'mock' }), rows)
  assert.ok(
    !runnableAcceptanceRows({ OPENFARM_SIM: 'docker' }).includes(
      'farm-page-camera',
    ),
  )
})

test('summary binds row pass/fail results to the candidate commit', () => {
  assert.deepEqual(
    buildAcceptanceSummary('abc123', [
      { suite: 'rtc-farm', row: 'farm-page-pause', passed: true },
      { suite: 'network-fault', row: 'udp-block', passed: false },
    ]),
    {
      commit: 'abc123',
      result: 'failed',
      rows: [
        { suite: 'rtc-farm', row: 'farm-page-pause', passed: true },
        { suite: 'network-fault', row: 'udp-block', passed: false },
      ],
    },
  )
})

test('runner reports are parsed before trailing failure diagnostics', () => {
  assert.deepEqual(
    parseLastJson(
      'build output\n{\n  "result": "failed",\n  "results": [{"scenario":"x","passed":false}]\n}\nError: suite failed',
    ),
    { result: 'failed', results: [{ scenario: 'x', passed: false }] },
  )
})

test('an overall suite failure preserves each row outcome', () => {
  assert.equal(
    rowPassed(
      [
        { row: 'farm-page-disconnect', passed: false },
        { row: 'command-rejected-tampered', passed: true },
      ],
      'command-rejected-tampered',
    ),
    true,
  )
})

test('mock mode defers network-fault profiles; docker mode keeps only hardware deferred', () => {
  assert.deepEqual(NETWORK_FAULT_PROFILES, ['nat', 'netem', 'udp-block'])
  const mock = deferredAcceptanceRows({ OPENFARM_SIM: 'mock' })
  assert.equal(mock.length, 4)
  assert.ok(mock.every((row) => row.row !== undefined))
  assert.equal(mock.at(-1)?.row, HARDWARE_ACCEPTANCE_DEFERRED.row)
  assert.deepEqual(
    deferredAcceptanceRows({ OPENFARM_SIM: 'docker' }).map((row) => row.row),
    [HARDWARE_ACCEPTANCE_DEFERRED.row],
  )
})
