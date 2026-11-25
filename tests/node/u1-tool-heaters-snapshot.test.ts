import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ToolHeaters } from '../../packages/farm-protocol/src/state.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  CompleteFarmSnapshot,
  FarmSnapshotProvider,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'

const toolHeaters: ToolHeaters = [
  { tool: 0, maxC: 300 },
  { tool: 1, maxC: 300 },
  { tool: 2, maxC: 300 },
  { tool: 3, maxC: 300 },
]

function liveSnapshot(t: test.TestContext, heaters: ToolHeaters | undefined) {
  const agent = randomUUID()
  const refs = [
    { assignmentId: randomUUID(), agentId: agent, printerKey: 'u1' },
  ]
  const now = 100
  const source = createFarmSnapshotSource({
    assignmentRefs: refs,
    nowMono: () => now,
    controlsFor: () => ['pause', 'resume', 'cancel', 'set_tool_temperature'],
  })
  const controller = new AbortController()
  t.after(() => {
    controller.abort()
    source.close()
  })
  const received: CompleteFarmSnapshot[] = []
  const binding: Parameters<FarmSnapshotProvider>[0]['binding'] = {
    v: 1,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: agent,
    account_id: 'account',
    key_id: randomUUID(),
    browser_public_key: { kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' },
    browser_thumbprint: 'test',
    connector_public_key_spki: 'test',
    connector_fingerprint: 'test',
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'test',
    browser_nonce: 'test',
    connector_nonce: 'test',
    issued_at: 0,
    expires_at: 10000,
    commands_enabled: false,
    offer_sha256: 'test',
    answer_sha256: 'test',
    browser_dtls: 'test',
    connector_dtls: 'test',
  }
  source.observe({
    printerKey: 'u1',
    epoch: 1,
    printer: {
      printerKey: 'u1',
      state: 'printing',
      progress: 0.2,
      observedAt: 10,
      ...(heaters ? { toolHeaters: heaters } : {}),
    },
    status: {
      webhooks: { state: 'ready' },
      print_stats: { state: 'printing' },
      virtual_sdcard: { progress: 0.2 },
    },
    fieldObservedAtMonoMs: { webhooks: now, printState: now, progress: now },
    receivedAtMonoMs: now,
  })
  source.open({
    binding,
    deadlineMonoMs: 10000,
    assignmentRefs: refs,
    signal: controller.signal,
    onComplete(value) {
      received.push(value)
    },
    onUnavailable() {
      assert.fail('Snapshot unexpectedly unavailable')
    },
  })
  const printer = received.at(-1)?.printers[0]
  assert.ok(printer)
  return printer
}

test('live snapshot carries the observed U1 tool heaters to the browser', (t) => {
  assert.deepEqual(liveSnapshot(t, toolHeaters).toolHeaters, toolHeaters)
})

test('live snapshot omits tool heaters when none were observed', (t) => {
  assert.equal('toolHeaters' in liveSnapshot(t, undefined), false)
})
