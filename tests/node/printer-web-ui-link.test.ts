import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type { FarmSnapshotProvider } from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { localInterfaceOrigin } from '../../apps/farm/app/utils/farm-view.ts'
import { resolvedLocalInterfaceOrigin } from '../../apps/farm/app/utils/farm-view.ts'
import { moonrakerWebUiOrigin } from '../../packages/connector/src/config/moonraker.ts'
import { crealityWebUiOrigin } from '../../packages/connector/src/config/creality.ts'

test('snapshot inventory carries a validated binding web UI origin', () => {
  const agentId = randomUUID()
  const refs = [
    { assignmentId: randomUUID(), agentId, printerKey: 'printer-a' },
  ]
  const source = createFarmSnapshotSource({
    assignmentRefs: refs,
    localWebUiOriginFor: () => moonrakerWebUiOrigin('http://192.168.1.20:7125'),
    nowMono: () => 100,
  })
  const received: Array<{ printers: readonly PrinterState[] }> = []
  const binding: Parameters<FarmSnapshotProvider>[0]['binding'] = {
    v: 1 as const,
    purpose: 'read-only-rtc' as const,
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: agentId,
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
    commands_enabled: false as const,
    offer_sha256: 'test',
    answer_sha256: 'test',
    browser_dtls: 'test',
    connector_dtls: 'test',
  }
  const controller = new AbortController()
  try {
    source.observe({
      printerKey: 'printer-a',
      epoch: 1,
      printer: {
        printerKey: 'printer-a',
        state: 'printing',
        progress: 0.2,
        observedAt: 10,
      },
      status: {
        webhooks: { state: 'ready' },
        print_stats: { state: 'printing' },
        virtual_sdcard: { progress: 0.2 },
      },
      fieldObservedAtMonoMs: { webhooks: 100, printState: 100, progress: 100 },
      receivedAtMonoMs: 100,
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
        assert.fail('complete configured snapshot should be available')
      },
    })
    assert.equal(
      received[0]?.printers[0]?.localWebUiOrigin,
      'http://192.168.1.20',
    )
  } finally {
    controller.abort()
    source.close()
  }
})

test('web UI origins reject credentials and the manual override remains credential-free', () => {
  assert.equal(
    crealityWebUiOrigin({ host: 'printer.local' }),
    'http://printer.local',
  )
  assert.equal(
    crealityWebUiOrigin({ host: 'printer.local', httpPort: 8080 }),
    'http://printer.local:8080',
  )
  assert.equal(
    PrinterState.safeParse({
      printerKey: 'printer-a',
      state: 'offline',
      observedAt: 10,
      localWebUiOrigin: crealityWebUiOrigin({ host: 'printer.local' }),
    }).success,
    true,
  )
  assert.equal(
    PrinterState.safeParse({
      printerKey: 'printer-a',
      state: 'offline',
      observedAt: 10,
      localWebUiOrigin: 'http://user:secret@192.168.1.20:7125',
    }).success,
    false,
  )
  assert.equal(
    localInterfaceOrigin('http://user:secret@192.168.1.20:7125'),
    null,
  )
  assert.equal(
    localInterfaceOrigin('http://192.168.1.20:7125'),
    'http://192.168.1.20:7125',
  )
  assert.equal(
    resolvedLocalInterfaceOrigin('http://manual.local', 'http://printer.local'),
    'http://manual.local',
  )
  assert.equal(
    resolvedLocalInterfaceOrigin(null, 'http://printer.local'),
    'http://printer.local',
  )
})

test('farm page renders the derived link as a safe external anchor', async () => {
  const { readFile } = await import('node:fs/promises')
  const page = await readFile(
    new URL('../../apps/farm/app/pages/farm.vue', import.meta.url),
    'utf8',
  )
  const anchor =
    /<a\s+:href="displayLocalOrigin\(row\) \?\? undefined"[^>]*>/.exec(
      page,
    )?.[0]
  assert.ok(anchor, 'link is bound to the derived origin')
  assert.match(anchor, /target="_blank"/)
  assert.match(anchor, /rel="noopener noreferrer"/)
  assert.match(anchor, /referrerpolicy="no-referrer"/)
})
