import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  decodeApiEnvelopeResultFrame,
  encodeApiEnvelopeFrame,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import { refuseApiCommand } from '../../packages/connector/src/runtime/pause-control.ts'

test('API command admission paths send busy, offline, and unsupported refusals', () => {
  const source = readFileSync(
    resolve('packages/connector/src/runtime/pause-control.ts'),
    'utf8',
  )
  assert.match(source, /refuseApiCommand\(frame, inbox, 'printer-busy'\)/)
  assert.match(source, /refuseApiCommand\(frame, inbox, 'not-ready'\)/)
  assert.match(source, /refuseApiCommand\(frame, inbox, 'unsupported'\)/)
})

test('API command refusal reports the original command ID and refusal code', () => {
  const cmdId = randomUUID()
  const wire = encodeApiEnvelopeFrame({
    v: 1,
    t: 'api-envelope.command',
    envelope: {
      v: 1,
      purpose: 'api-envelope',
      issuer: 'open3dfarm:api-envelope-issuer',
      kid: 'test',
      app_id: randomUUID(),
      grant_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      assignment_id: randomUUID(),
      resource_id: randomUUID(),
      cmd_id: cmdId,
      nonce: 'A'.repeat(22),
      issued_at: 1000,
      expires_at: 2000,
      kind: 'action',
      action: { action: 'pause', args: {} },
      signature: 'A'.repeat(86),
    },
  })
  const reports: string[] = []
  for (const code of ['printer-busy', 'not-ready', 'unsupported'] as const)
    refuseApiCommand(
      { wire } as never,
      { report: (result: string) => reports.push(result) } as never,
      code,
    )

  assert.equal(reports.length, 3)
  for (const [index, code] of [
    'printer-busy',
    'not-ready',
    'unsupported',
  ].entries()) {
    const result = decodeApiEnvelopeResultFrame(reports[index])
    assert.equal(result.cmd_id, cmdId)
    assert.equal(result.outcome, 'refused')
    assert.equal(result.refusal_code, code)
  }
})
