import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { setTimeout as delay } from 'node:timers/promises'
import {
  startAnycubicSimulator,
  packet,
} from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'
import { createAnycubicLanClient } from '../../packages/connector/src/anycubic/index.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  CompleteFarmSnapshot,
  FarmSnapshotProvider,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (condition()) return
    await delay(10)
  }
  throw Error('Timed out waiting for snapshot')
}

test('Anycubic lifecycle reports completed, cancelled and failed jobs through snapshots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anycubic-job-'))
  const passwordFile = join(dir, 'password.json')
  writeFileSync(passwordFile, JSON.stringify('password'), { mode: 0o600 })
  const sim = await startAnycubicSimulator({
    serial: '20024/TEST',
    printDurationMs: 500,
    reportIntervalMs: 60_000,
  })
  const controller = new AbortController()
  const agent = randomUUID()
  const refs = [
    { assignmentId: randomUUID(), agentId: agent, printerKey: 'fixture' },
  ]
  const source = createFarmSnapshotSource({ assignmentRefs: refs })
  const snapshots: CompleteFarmSnapshot[] = []
  let observations = 0
  const collector = createAnycubicCollection({
    binding: {
      printerKey: 'fixture',
      host: sim.host,
      port: sim.port,
      modelId: '20024',
      deviceId: 'TEST',
      username: 'user',
      passwordFile,
    },
    signal: controller.signal,
    transport: (options) =>
      createAnycubicLanClient({ ...options, caPem: sim.syntheticTrust }),
    onObservation(value) {
      source.observe(value)
      observations++
    },
    onUnavailable(epoch) {
      source.invalidate({ printerKey: 'fixture', epoch })
    },
  })
  const socket = connect({
    host: sim.host,
    port: sim.port,
    ca: sim.syntheticTrust,
  })
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
  const latest = () => snapshots.at(-1)?.printers[0]
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve)
      socket.once('error', reject)
    })
    socket.write(
      packet(16, Buffer.from('00044d51545404020000000474657374', 'hex')),
    )
    await new Promise<void>((resolve) => socket.once('data', () => resolve()))
    const publish = (topic: string, value: unknown) => {
      const name = Buffer.from(topic),
        length = Buffer.alloc(2)
      length.writeUInt16BE(name.length)
      socket.write(
        packet(
          48,
          Buffer.concat([length, name, Buffer.from(JSON.stringify(value))]),
        ),
      )
    }
    const start = () =>
      publish(
        'anycubic/anycubicCloud/v1/slicer/printer/20024/20024/TEST/print',
        {
          type: 'print',
          action: 'start',
          data: { filename: 'part.gcode' },
        },
      )
    sim.upload('part.gcode', Buffer.from('G28\n'))
    await until(() => {
      sim.publishReport({ data: { state: 'idle', progress: 0 } })
      return observations > 0
    })
    source.open({
      binding,
      assignmentRefs: refs,
      deadlineMonoMs: performance.now() + 10000,
      signal: controller.signal,
      onComplete(value) {
        snapshots.push(value)
      },
      onUnavailable() {},
    })

    let progress = 10
    const projectReport = async (
      project: Record<string, unknown>,
      estimatedRemainingSeconds?: number,
    ) => {
      const nextProgress = ++progress
      sim.publishReport({
        data: {
          state: 'busy',
          project: { progress: nextProgress, ...project },
        },
      })
      await until(() => latest()?.progress === nextProgress / 100)
      assert.equal(
        latest()?.estimatedRemainingSeconds,
        estimatedRemainingSeconds,
      )
      assert.equal(latest()?.lastJob, undefined)
    }
    for (const state of ['checking', 'stopped', 'future_phase']) {
      await projectReport({ state: 'printing', remain_time: 0 }, 0)
      await projectReport({ remain_time: 7 }, 420)
      await projectReport({}, 420)
      await projectReport({ state, remain_time: 0 })
      await projectReport({ remain_time: 0 })
      await projectReport({ state: 'printing', pause: 1, remain_time: 0 }, 0)
      assert.equal(latest()?.state, 'paused')
    }
    await projectReport({ state: 'stoped' })
    sim.publishReport({
      data: { state: 'busy', project: { state: 'error', progress } },
    })
    await until(() => latest()?.lastJob?.outcome === 'failed')
    assert.equal(latest()?.state, 'error')
    assert.equal(latest()?.estimatedRemainingSeconds, undefined)

    for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
      start()
      await until(() => latest()?.state === 'printing')
      assert.equal(latest()?.lastJob, undefined)
      sim.setRemainingMinutes(7)
      await until(() => latest()?.estimatedRemainingSeconds === 420)
      if (outcome === 'cancelled')
        publish(
          'anycubic/anycubicCloud/v1/printer/public/20024/TEST/print/request',
          { type: 'print', action: 'stop' },
        )
      if (outcome === 'failed') sim.failPrint()
      await until(() => latest()?.lastJob?.outcome === outcome)
      const finished = latest()?.lastJob
      assert.equal(latest()?.estimatedRemainingSeconds, undefined)
      assert.ok(Number.isSafeInteger(finished?.endedAt))
      await delay(120)
      assert.deepEqual(latest()?.lastJob, finished)
    }
  } finally {
    controller.abort()
    socket.destroy()
    await collector.done
    source.close()
    await sim.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
