import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allAcceptanceRows,
  buildAcceptanceSummary,
  parseLastJson,
  runnableAcceptanceRows,
} from '../../scripts/rtc-farm-all-mode.ts'

test('all mode selects every registered RTC farm row, including opt-in resource rows', () => {
  const rows = allAcceptanceRows()
  assert.ok(rows.includes('farm-page-camera'))
  assert.ok(rows.includes('farm-page-simulator-inventory'))
  assert.ok(rows.includes('farm-page-printing-pause'))
  assert.equal(new Set(rows).size, rows.length)
  assert.ok(!runnableAcceptanceRows().includes('farm-page-camera'))
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
