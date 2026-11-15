import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import {
  startBambuSimulator,
  packet,
} from '../../packages/sim-tools/src/bambu-simulator.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  CompleteFarmSnapshot,
  FarmSnapshotProvider,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { parseLocalCollectorConfig } from '../../packages/connector/src/config/local.ts'

test(
  'collector records simulator job completion, cancellation and failure',
  { timeout: 15000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bambu-end-'))
    const peer = await startBambuSimulator({
      initialState: 'IDLE',
      printDurationMs: 500,
    })
    const credentialFile = join(dir, 'credentials.json')
    const caFile = join(dir, 'ca.pem')
    writeFileSync(credentialFile, JSON.stringify({ accessCode: 'synthetic' }), {
      mode: 0o600,
    })
    writeFileSync(caFile, peer.syntheticTrust)
    const queue = new TelemetryQueue(join(dir, 'queue'), Date.now())
    const controller = new AbortController()
    const agent = randomUUID()
    const refs = [
      { assignmentId: randomUUID(), agentId: agent, printerKey: 'fixture' },
    ]
    const source = createFarmSnapshotSource({ assignmentRefs: refs })
    const snapshots: CompleteFarmSnapshot[] = []
    let observations = 0
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
    const done = collectIntoQueue({
      config: parseLocalCollectorConfig({
        version: 3,
        allowedOrigins: [],
        printers: [],
        bambu: {
          printers: [
            {
              printerKey: 'fixture',
              serial: 'SYNTHETIC',
              host: peer.host,
              port: peer.port,
              credentialFile,
              caFile,
              allowedEndpoints: [{ host: peer.host, port: peer.port }],
            },
          ],
        },
      }),
      queue,
      signal: controller.signal,
      onDiagnostic() {},
      onRawObservation(value) {
        observations++
        source.observe(value)
      },
      onRawUnavailable: source.invalidate,
    })
    const socket = connect({
      host: peer.host,
      port: peer.port,
      ca: peer.syntheticTrust,
    })
    async function until(predicate: () => boolean) {
      const end = Date.now() + 5000
      while (!predicate()) {
        if (Date.now() > end)
          throw Error(
            'Timed out waiting for simulator state ' + JSON.stringify(latest()),
          )
        await delay(10)
      }
    }
    const latest = () => snapshots.at(-1)?.printers[0]
    try {
      await once(socket, 'secureConnect')
      const connected = once(socket, 'data')
      socket.write(
        Buffer.from([16, 13, 0, 4, 77, 81, 84, 84, 4, 2, 0, 10, 0, 1, 120]),
      )
      await connected
      const topic = Buffer.from('device/SYNTHETIC/request')
      const size = Buffer.alloc(2)
      size.writeUInt16BE(topic.length)
      const send = (command: string) =>
        socket.write(
          packet(
            48,
            Buffer.concat([
              size,
              topic,
              Buffer.from(
                JSON.stringify({
                  print: {
                    command,
                    sequence_id: '1',
                    param: 'Metadata/plate_1.gcode',
                    url: 'file:///sdcard/test.3mf',
                  },
                }),
              ),
            ]),
          ),
        )
      peer.uploadFile('test.3mf', Buffer.from('fixture'))
      await until(() => observations > 0)
      source.open({
        binding,
        assignmentRefs: refs,
        deadlineMonoMs: performance.now() + 12000,
        signal: controller.signal,
        onComplete(value) {
          snapshots.push(value)
        },
        onUnavailable() {},
      })
      for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
        send('project_file')
        await until(() => latest()?.state === 'printing')
        if (outcome === 'cancelled') send('stop')
        if (outcome === 'failed') peer.failPrint()
        await until(() => latest()?.lastJob?.outcome === outcome)
        const finished = latest()?.lastJob
        assert.ok(Number.isSafeInteger(finished?.endedAt))
        await delay(100)
        assert.deepEqual(latest()?.lastJob, finished)
      }
    } finally {
      controller.abort()
      socket.destroy()
      await done
      source.close()
      queue.close()
      await peer.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
