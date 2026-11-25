import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import {
  closeCommandJournal,
  openCommandJournal,
  readCommandOutcome,
} from '../../packages/connector/src/control/command-journal.ts'
import { DriverRefusalError } from '../../packages/connector/src/control/driver-refusal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'
import {
  API_ENVELOPE_ISSUER,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
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

test('typed local refusals are not sent; ambiguous failures stay blocked', async (t) => {
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const directory = mkdtempSync(join(tmpdir(), 'api-refusal-'))
  const wall = Date.now()
  const clock = { wallNow: () => wall, monotonicNow: () => 1000 }
  const journal = openCommandJournal({ directory, clock: () => wall })
  t.after(() => {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true })
  })
  const farm = randomUUID(),
    agent = randomUUID(),
    assignment = randomUUID()
  const app = randomUUID(),
    grant = randomUUID()
  const origin = 'http://127.0.0.1:7125'
  const registry = createPrinterBindingRegistry({ allowedOrigins: [origin] })
  const binding = registry.provision({
    assignment_id: assignment,
    farm_id: farm,
    agent_id: agent,
    printer_key: 'synthetic',
    moonraker_origin: origin,
  })
  const authority = createOfflineAuthority()
  authority.confirm({ wall, mono: 1000 }, 1)
  let failure: unknown
  let calls = 0
  const reports: ReturnType<typeof decodeApiEnvelopeResultFrame>[] = []
  const runner = createApiCommandRunner({
    farmId: farm,
    agentId: agent,
    keys: { issuer: () => issuer.publicKey },
    grants: {
      lookup: () => ({
        grant_id: grant,
        app_id: app,
        farm_id: farm,
        scopes: ['control:basic'],
        revoked: false,
      }),
      freshness: authority.freshness,
    },
    journal,
    printer: () => binding,
    observe: () => ({ ready: true, printState: 'printing' }),
    driver: {
      controls: () => ['pause'],
      macros: () => [],
      async execute() {
        calls++
        throw failure
      },
    },
    report: (wire) => reports.push(decodeApiEnvelopeResultFrame(wire)),
    clock,
  })
  async function wire() {
    return encodeApiEnvelopeFrame({
      v: 1,
      t: 'api-envelope.command',
      envelope: await signApiEnvelope(
        {
          v: 1,
          purpose: 'api-envelope',
          issuer: API_ENVELOPE_ISSUER,
          kid: 'test',
          app_id: app,
          grant_id: grant,
          farm_id: farm,
          agent_id: agent,
          assignment_id: assignment,
          resource_id: randomUUID(),
          cmd_id: randomUUID(),
          nonce: newApiEnvelopeNonce(),
          issued_at: wall,
          expires_at: wall + 60000,
          kind: 'action',
          action: { action: 'pause', args: {} },
        },
        issuer.privateKey,
      ),
    })
  }
  for (const [reason, code] of [
    ['state', 'wrong-state'],
    ['unsupported-action', 'unsupported'],
    ['invalid-command', 'unsupported'],
  ] as const) {
    failure = new DriverRefusalError(reason, 'synthetic refusal')
    const command = await wire()
    const result = await runner.run(command)
    assert.deepEqual(result, { kind: 'refused', code, detail: reason })
    assert.equal(
      readCommandOutcome(journal, JSON.parse(command).envelope.cmd_id)?.status,
      'not-sent',
    )
    assert.equal(reports.at(-1)?.refusal_code, code)
    assert.equal(reports.at(-1)?.detail, reason)
    assert.deepEqual(await runner.run(command), {
      kind: 'dropped',
      reason: 'replay',
    })
  }
  failure = new Error('ambiguous')
  const command = await wire()
  assert.deepEqual(await runner.run(command), { kind: 'outcome-unknown' })
  assert.equal(
    readCommandOutcome(journal, JSON.parse(command).envelope.cmd_id)?.status,
    'outcome-unknown',
  )
  assert.deepEqual(await runner.run(command), {
    kind: 'dropped',
    reason: 'replay',
  })
  assert.equal(calls, 4)
  assert.equal(reports.length, 3)
  assert.equal((await runner.run(await wire())).kind, 'refused')
  assert.equal(calls, 4)
})
