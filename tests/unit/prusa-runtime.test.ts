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
import { startPrusaSimulator } from '../../packages/sim-tools/src/prusa-simulator.ts'

test('legacy collector config still parses without driver registration', () => {
  const origin = 'http://127.0.0.1:7125'
  expect(
    parseCollectorConfig({
      version: 1,
      allowedOrigins: [origin],
      printers: [{ printerKey: 'legacy', origin }],
    }),
  ).toMatchObject({ version: 1, printers: [{ printerKey: 'legacy', origin }] })
})

test('real PrusaLink collection binds identity, withdraws failed reads and recovers read-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prusa-runtime-'))
  const controller = new AbortController()
  let mode = 'printing'
  const methods: string[] = []
  const simulator = await startPrusaSimulator((req, res) => {
    methods.push(req.method ?? '')
    if (req.headers['x-api-key'] !== 'test-key' || mode === 'auth') {
      res.writeHead(401).end()
      return
    }
    const data =
      req.url === '/api/version'
        ? { api: '1.0.0', printer: mode === 'model' ? '1.3.0' : '1.4.0' }
        : req.url === '/api/v1/info'
          ? { serial: 'TEST-PRUSA' }
          : req.url === '/api/v1/status'
            ? {
                printer: {
                  state: mode === 'printing' ? 'PRINTING' : 'NEW_STATE',
                },
              }
            : undefined
    if (req.url === '/api/v1/status' && mode === 'stale') return
    res
      .writeHead(data ? 200 : 404, { 'content-type': 'application/json' })
      .end(JSON.stringify(data))
  })
  const queue = new TelemetryQueue(join(dir, 'queue'), Date.now())
  let run: Promise<void> | undefined
  try {
    const apiKeyFile = join(dir, 'key.json')
    const path = join(dir, 'runtime.json')
    writeFileSync(
      apiKeyFile,
      JSON.stringify({ origin: simulator.endpoint, apiKey: 'test-key' }),
      { mode: 0o600 },
    )
    const credential = { agent_id: randomUUID(), farm_id: randomUUID() }
    const assignment_id = randomUUID()
    const config = {
      version: 8,
      collection: {
        version: 8,
        allowedOrigins: [],
        printers: [],
        limits: { requestTimeoutMs: 350 },
        drivers: [
          {
            family: 'prusa-link',
            printerKey: 'prusa',
            origin: simulator.endpoint,
            apiKeyFile,
            expect: { serial: 'TEST-PRUSA', printerType: '1.4.0' },
          },
        ],
      },
      assignments: [
        {
          ...credential,
          assignment_id,
          printer_key: 'prusa',
          backend: 'prusa-link',
        },
      ],
      telemetry: { endpoint: 'https://farm.example', audience: 'telemetry' },
    }
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
    const runtime = readAgentRuntimeConfig(path, credential)
    const handle = runtime.bindingFor(assignment_id)
    expect(handle).toBeDefined()
    expect(readPrinterBinding(handle!)).toBeNull()
    const { publicKey } = generateKeyPairSync('ed25519')
    const origin = 'https://farm.example'
    writeFileSync(
      path,
      JSON.stringify({
        ...config,
        pause: {
          version: 1,
          issuers: [
            {
              issuer: origin,
              kid: 'test',
              publicKeySpki: publicKey
                .export({ type: 'spki', format: 'der' })
                .toString('base64url'),
            },
          ],
          control: { assignmentIds: [assignment_id] },
          signalling: {
            origin,
            endpoint: 'wss://farm.example/api/signalling/pause-connector',
            audience: 'pause',
            credentialAudience: 'credential',
          },
        },
      }),
    )
    expect(() => readAgentRuntimeConfig(path, credential)).toThrow(
      'Backend does not support pause control',
    )

    const refs = [
      {
        assignmentId: assignment_id,
        agentId: credential.agent_id,
        printerKey: 'prusa',
      },
    ]
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
      let state: string | undefined
      const subscription = source.open({
        binding,
        assignmentRefs: refs,
        signal: controller.signal,
        deadlineMonoMs: performance.now() + 5000,
        onComplete: (value) => {
          state = value.printers[0]?.state
        },
        onUnavailable() {},
      })
      subscription.close()
      return state
    }

    const events: unknown[] = []
    run = collectIntoQueue({
      config: runtime.collection,
      queue,
      signal: controller.signal,
      onDiagnostic() {},
      onRawObservation(value) {
        source.observe(value)
        const { epoch, printer } = value
        events.push({ epoch, state: printer.state, identity: printer.identity })
      },
      onRawUnavailable(value) {
        source.invalidate(value)
        events.push({ epoch: value.epoch, state: 'withdrawn' })
      },
    })
    const identity = { vendor: 'Prusa', model: '1.4.0' }
    async function event(index: number, expected: unknown) {
      await expect
        .poll(() => events[index], { timeout: 4000 })
        .toEqual(expected)
    }
    await event(0, { epoch: 1, state: 'printing', identity })
    expect(snapshot()).toBe('printing')
    mode = 'stale'
    await event(1, { epoch: 1, state: 'withdrawn' })
    expect(snapshot()).toBe(undefined)
    mode = 'unknown'
    await event(2, { epoch: 2, state: 'unknown', identity })
    expect(snapshot()).toBe('unknown')
    mode = 'model'
    await event(3, { epoch: 2, state: 'withdrawn' })
    expect(snapshot()).toBe(undefined)
    mode = 'printing'
    await event(4, { epoch: 3, state: 'printing', identity })
    expect(snapshot()).toBe('printing')
    mode = 'auth'
    await event(5, { epoch: 3, state: 'withdrawn' })
    expect(snapshot()).toBe(undefined)
    expect(new Set(methods)).toEqual(new Set(['GET']))
  } finally {
    controller.abort()
    await run
    queue.close()
    await simulator.close()
    rmSync(dir, { recursive: true })
  }
}, 18000)
