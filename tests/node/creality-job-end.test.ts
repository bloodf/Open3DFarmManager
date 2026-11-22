import type { FarmSnapshotProvider } from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { randomUUID } from 'node:crypto'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { createCrealityCollection } from '../../packages/connector/src/runtime/creality-collection.ts'

const require = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)
const WebSocket = require('ws')
async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(predicate(), `timed out waiting for ${description}`)
}

for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
  test(`Creality collector reports ${outcome}`, async () => {
    const sim = await createCrealitySimulator(
      { state: 0, printProgress: 0 },
      { durationMs: 300, fail: outcome === 'failed' },
    )
    const controller = new AbortController()
    const agent = randomUUID()
    const refs = [
      { assignmentId: randomUUID(), agentId: agent, printerKey: 'fixture' },
    ]
    const source = createFarmSnapshotSource({ assignmentRefs: refs })
    const observations: any[] = []
    const collector = createCrealityCollection({
      binding: { printerKey: 'fixture', host: '127.0.0.1', port: sim.port },
      signal: controller.signal,
      onObservation: (value) => {
        source.observe(value)
        observations.push(value.printer)
      },
      onUnavailable() {},
    })
    const ws = new WebSocket(`ws://127.0.0.1:${sim.port}`)
    try {
      await new Promise<void>((resolve) => ws.once('open', resolve))
      await waitFor(() => observations.length > 0, 'collector connection')
      ws.send(
        JSON.stringify({
          method: 'upload',
          params: { filename: 'part.gcode' },
        }),
      )
      ws.send(JSON.stringify({ method: 'start', params: {} }))
      if (outcome === 'cancelled') {
        await waitFor(
          () => Number(sim.state.printProgress) > 0,
          'simulator print progress before cancellation',
        )
        ws.send(JSON.stringify({ method: 'set', params: { stop: 1 } }))
      }
      await waitFor(
        () => observations.some((p) => p.lastJob),
        'collector last job',
      )
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
      const snapshots: any[] = []
      source.open({
        binding,
        assignmentRefs: refs,
        deadlineMonoMs: performance.now() + 1000,
        signal: controller.signal,
        onComplete: (value) => snapshots.push(value),
        onUnavailable() {},
      })
      const finished = snapshots.at(-1)?.printers[0]?.lastJob
      assert.equal(finished?.outcome, outcome)
      assert.ok(Number.isSafeInteger(finished?.endedAt))
    } finally {
      controller.abort()
      ws.terminate()
      await collector.done
      source.close()
      await sim.close()
    }
  })
}
