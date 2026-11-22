import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('API command admission paths send busy, offline, and unsupported refusals', () => {
  const source = readFileSync(
    resolve('packages/connector/src/runtime/pause-control.ts'),
    'utf8',
  )
  assert.match(source, /refuseApiCommand\(frame, inbox, 'printer-busy'\)/)
  assert.match(source, /refuseApiCommand\(frame, inbox, 'not-ready'\)/)
  assert.match(source, /refuseApiCommand\(frame, inbox, 'unsupported'\)/)
})
