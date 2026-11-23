import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { readPrinterBinding } from '../../packages/connector/src/control/printer-binding.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { parseCollectorConfig } from '../../packages/connector/src/prusa/config.ts'

import { startQidiSimulator } from '../../packages/sim-tools/src/qidi-simulator.ts'
import { startFlashforgeSimulator } from '../../packages/sim-tools/src/flashforge-simulator.ts'
import { startPhrozenSimulator } from '../../packages/sim-tools/src/phrozen-simulator.ts'
import qidiFixture from '../fixtures/qidi/moonraker.json'
import flashFixture from '../fixtures/flashforge/detail.json'
import phrozenFixture from '../fixtures/phrozen/synthetic-revo-14k-v153.json'

test('mixed v8 drivers publish read-only snapshots and withdraw stale epochs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mac-registration-'))
  const controller = new AbortController()
  const queue = new TelemetryQueue(join(dir, 'queue'), Date.now())
  const close: (() => Promise<void>)[] = []
  let run: Promise<void> | undefined
  try {
    const info = structuredClone(qidiFixture.info)
    const qidi = await startQidiSimulator({
      ...qidiFixture,
      info,
      snapshot: new Uint8Array(),
    })
    close.push(qidi.close)
    let flashReply: unknown = flashFixture
    const flashCalls: string[] = []
    const flash = await startFlashforgeSimulator((req, res) => {
      flashCalls.push(`${req.method} ${req.url}`)
      res.end(JSON.stringify(flashReply))
    })
    close.push(flash.close)
    const phrozen = await startPhrozenSimulator(structuredClone(phrozenFixture))
    close.push(phrozen.close)
    const flashOrigin = `http://${flash.host}:${flash.port}`
    const credentialFile = join(dir, 'flash.json')
    writeFileSync(
      credentialFile,
      JSON.stringify({
        origin: flashOrigin,
        serialNumber: 'FIXTURE-SERIAL',
        checkCode: 'FIXTURE-CODE',
      }),
      { mode: 0o600 },
    )
    const drivers = [
      {
        family: 'qidi',
        printerKey: 'qidi',
        origin: qidi.origin,
        simulated: false,
        expect: {
          model: 'Q1 Pro',
          firmware: '4.4.24',
          moonrakerVersion: 'v0.8.0',
        },
        auth: { kind: 'api-key', credentialFile: join(dir, 'qidi.json') },
      },
      {
        family: 'flashforge',
        printerKey: 'flashforge',
        origin: flashOrigin,
        simulated: false,
        credentialFile,
        expect: { serialNumber: 'FIXTURE-SERIAL', model: 'Adventurer 5M Pro' },
      },
      {
        family: 'phrozen',
        printerKey: 'phrozen',
        origin: `ws://127.0.0.1:${phrozen.wsPort}`,
        simulated: false,
        discoveryPort: phrozen.udpPort,
        expect: {
          id: phrozenFixture.Id,
          board: phrozenFixture.Data.MainboardID,
          model: 'Sonic Mighty Revo 14K',
          firmware: 'V153',
        },
      },
    ]
    writeFileSync(
      join(dir, 'qidi.json'),
      JSON.stringify({ origin: qidi.origin, secret: 'fixture-key' }),
      { mode: 0o600 },
    )
    const credential = { agent_id: randomUUID(), farm_id: randomUUID() }
    const config = {
      version: 8,
      collection: {
        version: 8,
        printers: [],
        allowedOrigins: drivers.map((d) => d.origin),
        drivers,
        limits: { requestTimeoutMs: 500 },
      },
      assignments: drivers.map((d) => ({
        ...credential,
        assignment_id: randomUUID(),
        printer_key: d.printerKey,
        backend: d.family,
      })),
      telemetry: { endpoint: 'https://farm.example', audience: 'telemetry' },
    }
    const path = join(dir, 'runtime.json')
    function read(value: unknown) {
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
      return readAgentRuntimeConfig(path, credential)
    }
    expect(() =>
      read({
        ...config,
        assignments: config.assignments.map((a) => ({
          ...a,
          backend: 'prusa-link',
        })),
      }),
    ).toThrow('assignment mismatch')
    expect(() =>
      parseCollectorConfig({
        ...config.collection,
        allowedOrigins: [
          ...config.collection.allowedOrigins,
          'ws://8.8.8.8:3030',
        ],
      }),
    ).toThrow()
    const { publicKey } = generateKeyPairSync('ed25519')
    for (const assignment of config.assignments) {
      expect(() =>
        read({
          ...config,
          pause: {
            version: 1,
            issuers: [
              {
                issuer: 'https://farm.example',
                kid: 'test',
                publicKeySpki: publicKey
                  .export({ type: 'spki', format: 'der' })
                  .toString('base64url'),
              },
            ],
            control: { assignmentIds: [assignment.assignment_id] },
            signalling: {
              origin: 'https://farm.example',
              endpoint: 'wss://farm.example/api/signalling/pause-connector',
              audience: 'pause',
              credentialAudience: 'credential',
            },
          },
        }),
      ).toThrow('Backend does not support pause control')
    }
    const moonrakerOrigin = 'http://127.0.0.1:7125'
    const moonraker = {
      ...credential,
      assignment_id: randomUUID(),
      printer_key: 'moonraker',
      moonraker_origin: moonrakerOrigin,
    }
    const mixed = read({
      ...config,
      collection: {
        ...config.collection,
        allowedOrigins: [...config.collection.allowedOrigins, moonrakerOrigin],
        printers: [{ printerKey: 'moonraker', origin: moonrakerOrigin }],
      },
      assignments: [...config.assignments, moonraker],
    })
    expect(
      readPrinterBinding(mixed.bindingFor(moonraker.assignment_id)!),
    ).toMatchObject(moonraker)
    const runtime = read(config)
    for (const a of config.assignments) {
      const handle = runtime.bindingFor(a.assignment_id)
      expect(handle).toBeDefined()
      expect(readPrinterBinding(handle!)).toBeNull()
    }
    const refs = config.assignments.map((a) => ({
      assignmentId: a.assignment_id,
      agentId: a.agent_id,
      printerKey: a.printer_key,
    }))
    const source = createFarmSnapshotSource({ assignmentRefs: refs })
    const binding: Parameters<typeof source.open>[0]['binding'] = {
      v: 1,
      purpose: 'read-only-rtc',
      transport_id: randomUUID(),
      farm_id: credential.farm_id,
      agent_id: credential.agent_id,
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

    function snapshot() {
      let printers: unknown[] = []
      const subscription = source.open({
        binding,
        assignmentRefs: refs,
        signal: controller.signal,
        deadlineMonoMs: performance.now() + 5000,
        onComplete: (value) => {
          printers = [...value.printers]
        },
        onUnavailable() {},
      })
      subscription.close()
      return printers
    }
    const withdrawn: string[] = []
    run = collectIntoQueue({
      config: runtime.collection,
      queue,
      signal: controller.signal,
      onDiagnostic() {},
      onRawObservation: (value) => source.observe(value),
      onRawUnavailable: (value) => {
        withdrawn.push(value.printerKey)
        source.invalidate(value)
      },
    })
    await expect.poll(snapshot, { timeout: 4000 }).toMatchObject([
      {
        printerKey: 'qidi',
        identity: { vendor: 'Qidi' },
        statusReason: 'qidi-unqualified',
      },
      {
        printerKey: 'flashforge',
        identity: {
          vendor: 'Flashforge',
          model: 'Adventurer 5M Pro',
          firmware: '5.1.8',
        },
        statusReason: 'flashforge-unqualified',
      },
      {
        printerKey: 'phrozen',
        identity: {
          vendor: 'Phrozen',
          model: 'Sonic Mighty Revo 14K',
          firmware: 'V153',
        },
        statusReason: 'phrozen-unqualified',
      },
    ])
    for (const printer of snapshot())
      expect(printer).not.toHaveProperty('controls')
    info.result.moonraker_version = 'wrong-version'
    flashReply = { code: 1 }
    phrozen.setFault('denied')
    await expect
      .poll(() => [...withdrawn].sort(), { timeout: 4500 })
      .toEqual(['flashforge', 'phrozen', 'qidi'])
    expect(snapshot()).toEqual([])
    expect(qidi.uploads).toEqual([])
    expect(qidi.requests.every((request) => request.startsWith('GET '))).toBe(
      true,
    )
    expect(new Set(flashCalls)).toEqual(new Set(['POST /detail']))
    expect(phrozen.commands.length).toBeGreaterThan(0)
    expect(new Set(phrozen.commands)).toEqual(new Set([0]))
  } finally {
    controller.abort()
    try {
      await run
    } finally {
      queue.close()
      await Promise.all(close.map((stop) => stop()))
      rmSync(dir, { recursive: true, force: true })
    }
  }
}, 12000)
