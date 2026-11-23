import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ToolHeaters } from '../../packages/farm-protocol/src/state.ts'
import {
  API_ENVELOPE_ISSUER,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'
import { controlWithinLimits } from '../../packages/connector/src/runtime/control-limits.ts'
import { toolTemperatureRefusal } from '../../packages/connector/src/control/control-driver.ts'

test('Connector refuses a tool write above its configured extruder ceiling', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tool-ceiling-'))
  const journal = openCommandJournal({ directory, clock: Date.now })
  try {
    const pair = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const farm = randomUUID(),
      agent = randomUUID(),
      grant = randomUUID(),
      app = randomUUID(),
      assignment = randomUUID()
    const binding = createPrinterBindingRegistry({
      allowedOrigins: ['http://127.0.0.1:7125'],
    }).provision({
      farm_id: farm,
      agent_id: agent,
      assignment_id: assignment,
      printer_key: 'fake',
      moonraker_origin: 'http://127.0.0.1:7125',
    })
    const sent: unknown[] = []
    const limits = { extruder: 220, bed: 120, chamber: 65 }
    const runner = createApiCommandRunner({
      farmId: farm,
      agentId: agent,
      journal,
      keys: { issuer: () => pair.publicKey },
      grants: {
        lookup: () => ({
          grant_id: grant,
          app_id: app,
          farm_id: farm,
          revoked: false,
          scopes: ['control:extended'],
        }),
        freshness: { freshAt: () => true },
      },
      printer: () => binding,
      observe: () => ({
        ready: true,
        printState: 'idle',
        toolHeaters: [{ tool: 0, maxC: 300 }],
      }),
      controlLimits: limits,
      clock: { wallNow: Date.now, monotonicNow: () => performance.now() },
      report: () => {},
      driver: {
        controls: () => ['set_tool_temperature'],
        async execute(action, args, { beforeSend }) {
          if (!beforeSend()) return { acknowledged: false }
          sent.push([action, args])
          return { acknowledged: true }
        },
      },
    })
    const now = Date.now()
    const wire = encodeApiEnvelopeFrame({
      v: 1,
      t: 'api-envelope.command',
      envelope: await signApiEnvelope(
        {
          v: 1,
          purpose: 'api-envelope',
          issuer: API_ENVELOPE_ISSUER,
          kind: 'action',
          kid: 'test',
          app_id: app,
          grant_id: grant,
          farm_id: farm,
          agent_id: agent,
          assignment_id: assignment,
          resource_id: randomUUID(),
          cmd_id: randomUUID(),
          nonce: newApiEnvelopeNonce(),
          issued_at: now,
          expires_at: now + 20000,
          scope: 'control:extended',
          grant_epoch: now,
          action: {
            action: 'set_tool_temperature',
            args: { tool: 0, target_c: 221 },
          },
        },
        pair.privateKey,
      ),
    })
    assert.deepEqual(await runner.run(wire), {
      kind: 'refused',
      code: 'unsupported',
      detail: 'action not supported by this printer',
    })
    assert.deepEqual(sent, [])
    assert.equal(
      controlWithinLimits(
        'set_tool_temperature',
        { tool: 0, target_c: 220 },
        limits,
      ),
      true,
    )
    assert.equal(
      controlWithinLimits('set_tool_temperature', { tool: 0, target_c: 301 }),
      false,
    )
    assert.equal(
      toolTemperatureRefusal(
        {
          ready: true,
          printState: 'idle',
          toolHeaters: [{ tool: 0, maxC: 200 }],
        },
        { tool: 0, target_c: 201 },
      ),
      'tool-temperature-above-maximum',
    )
  } finally {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('tool heater schema rejects an absurd observed maximum', () => {
  assert.equal(
    ToolHeaters.safeParse([{ tool: 0, maxC: 100000 }]).success,
    false,
  )
  assert.equal(ToolHeaters.safeParse([{ tool: 0, maxC: 300 }]).success, true)
})
