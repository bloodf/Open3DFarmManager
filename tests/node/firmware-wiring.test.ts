import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import type { CompleteFarmSnapshot } from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'

process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'
const require = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)
const { WebSocketServer } = require('ws')

async function moonrakerFixture() {
  let release: (() => void) | undefined
  let firmwareReads = 0
  const methods: string[] = []
  const server = createServer((request, response) => {
    if (request.url === '/machine/update/status') {
      firmwareReads++
      release = () =>
        response.end(
          JSON.stringify({
            result: {
              version_info: {
                klipper: {
                  version: 'v1',
                  remote_version: 'v2',
                  update_available: true,
                },
                moonraker: { version: 'm1', remote_version: 'm1' },
              },
            },
          }),
        )
    } else
      response.end(
        JSON.stringify({
          result: { klippy_connected: true, klippy_state: 'ready' },
        }),
      )
  })
  const websocket = new WebSocketServer({ server })
  let eventtime = 0
  websocket.on(
    'connection',
    (socket: {
      on(event: 'message', listener: (data: Buffer) => void): void
      send(data: string): void
    }) =>
      socket.on('message', (data) => {
        const request = JSON.parse(data.toString())
        methods.push(request.method)
        if (request.method === 'server.connection.identify') {
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { connection_id: 1 },
            }),
          )
          return
        }
        const result =
          request.method === 'printer.objects.list'
            ? { objects: [] }
            : {
                eventtime: ++eventtime,
                status: {
                  webhooks: { state: 'ready' },
                  print_stats: { state: 'printing' },
                  virtual_sdcard: { progress: 0.25 },
                },
              }
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
      }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Fixture address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    methods,
    reads: () => firmwareReads,
    release: () => release?.(),
    async close() {
      for (const socket of websocket.clients) socket.terminate()
      await new Promise<void>((resolve) => websocket.close(() => resolve()))
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test(
  'real agent composes firmware from all four vendor transports',
  { timeout: 30000 },
  async (t) => {
    const probe: { read: () => CompleteFarmSnapshot | undefined } = {
      read: () => undefined,
    }
    Object.assign(globalThis, { firmwareProbe: probe })
    const hooks = registerHooks({
      load(url, context, next) {
        if (url.endsWith('/runtime/signalling.ts'))
          return {
            format: 'module',
            shortCircuit: true,
            source: `export async function runSignallingLifecycle({signal}) { if (!signal.aborted) await new Promise(r => signal.addEventListener('abort', r, {once:true})); }`,
          }
        if (url.endsWith('/runtime/farm-snapshot-provider.ts'))
          return {
            format: 'module-typescript',
            shortCircuit: true,
            source: readFileSync(new URL(url), 'utf8').replace(
              'return { observe, invalidate, setInventory, open, close }',
              `globalThis.firmwareProbe.read = () => { const now = performance.now(); return snapshot(now, now + 5000); }; return { observe, invalidate, setInventory, open, close }`,
            ),
          }
        return next(url, context)
      },
    })
    try {
      const { runConnectorAgent } =
        await import('../../packages/connector/src/runtime/agent.ts')
      for (const vendor of [
        'moonraker',
        'bambu',
        'creality',
        'anycubic',
      ] as const)
        await t.test(vendor, async () => {
          const directory = mkdtempSync(join(tmpdir(), 'firmware-wiring-'))
          const controller = new AbortController()
          const cleanup: (() => Promise<void>)[] = []
          let timer: ReturnType<typeof setInterval> | undefined
          let running: Promise<void> | undefined
          let failure: unknown
          probe.read = () => undefined
          try {
            const identity = loadOrCreateIdentity(directory)
            const agent = randomUUID(),
              farm = randomUUID(),
              assignment = randomUUID()
            const scope = {
              assignment_id: assignment,
              agent_id: agent,
              farm_id: farm,
              printer_key: vendor,
            }
            let collection: object
            let assignmentConfig: object = scope
            let expected: object
            let assertReads = () => {}
            let beforeFirmware = async () => {}
            const credentialFile = join(directory, 'password.json')
            const caFile = join(directory, 'ca.pem')
            if (vendor === 'moonraker') {
              const remote = await moonrakerFixture()
              cleanup.push(remote.close)
              collection = {
                version: 1,
                allowedOrigins: [remote.origin],
                printers: [{ printerKey: vendor, origin: remote.origin }],
              }
              assignmentConfig = { ...scope, moonraker_origin: remote.origin }
              expected = {
                current: 'v1',
                latest: 'v2',
                updateAvailable: true,
                components: [
                  { name: 'klipper', current: 'v1', latest: 'v2' },
                  { name: 'moonraker', current: 'm1', latest: 'm1' },
                ],
              }
              beforeFirmware = async () => {
                await waitFor(
                  () => !!probe.read()?.printers.length && remote.reads() === 1,
                )
                assert.equal(probe.read()?.printers[0]?.firmware, undefined)
                remote.release()
              }
              assertReads = () => {
                assert.equal(remote.reads(), 1)
                assert.ok(
                  remote.methods.every((method) =>
                    [
                      'server.connection.identify',
                      'printer.objects.list',
                      'printer.objects.subscribe',
                      'printer.objects.query',
                    ].includes(method),
                  ),
                )
              }
            } else if (vendor === 'bambu') {
              const remote = await startBambuSimulator({
                initialState: 'IDLE',
                versionModules: [{ name: 'ota', sw_ver: '01.00.00.00' }],
              })
              cleanup.push(remote.close)
              writeFileSync(
                credentialFile,
                JSON.stringify({ accessCode: 'synthetic' }),
                { mode: 0o600 },
              )
              writeFileSync(caFile, remote.syntheticTrust)
              collection = {
                version: 3,
                allowedOrigins: [],
                printers: [],
                bambu: {
                  printers: [
                    {
                      printerKey: vendor,
                      host: '127.0.0.1',
                      port: remote.port,
                      serial: 'SYNTHETIC',
                      credentialFile,
                      caFile,
                      allowedEndpoints: [
                        { host: '127.0.0.1', port: remote.port },
                      ],
                    },
                  ],
                },
              }
              timer = setInterval(
                () =>
                  remote.publishReport({
                    print: {
                      gcode_state: 'IDLE',
                      mc_percent: 0,
                      upgrade_state: {
                        new_ver_list: [
                          { module: 'ota', version: '01.01.00.00' },
                        ],
                      },
                    },
                  }),
                50,
              )
              expected = {
                current: '01.00.00.00',
                latest: '01.01.00.00',
                updateAvailable: true,
                components: [
                  {
                    name: 'ota',
                    current: '01.00.00.00',
                    latest: '01.01.00.00',
                  },
                ],
              }
              assertReads = () => {
                assert.deepEqual(
                  remote.queries.map((request) => request.command),
                  ['get_version'],
                )
                // Reading the firmware never sends a printer command.
                assert.deepEqual(remote.requests, [])
              }
            } else if (vendor === 'creality') {
              const remote = await createCrealitySimulator(
                { state: 1, printProgress: 25 },
                { heartbeatMs: 50 },
              )
              cleanup.push(remote.close)
              collection = {
                version: 4,
                allowedOrigins: [],
                printers: [],
                creality: {
                  printers: [
                    {
                      printerKey: vendor,
                      host: '127.0.0.1',
                      port: remote.port,
                    },
                  ],
                },
              }
              beforeFirmware = async () => {
                await waitFor(() => !!probe.read()?.printers.length)
                assert.equal(probe.read()?.printers[0]?.firmware, undefined)
                remote.emitFrame({ modelVersion: 'C1' })
              }
              expected = { current: 'C1' }
              assertReads = () => assert.deepEqual(remote.received, [])
            } else {
              const remote = await startAnycubicSimulator({
                serial: '20024/SYNTHETIC',
              })
              cleanup.push(remote.close)
              writeFileSync(credentialFile, JSON.stringify('synthetic'), {
                mode: 0o600,
              })
              writeFileSync(caFile, remote.syntheticTrust)
              collection = {
                version: 5,
                allowedOrigins: [],
                printers: [],
                anycubic: {
                  printers: [
                    {
                      printerKey: vendor,
                      host: '127.0.0.1',
                      port: remote.port,
                      modelId: '20024',
                      deviceId: 'SYNTHETIC',
                      username: 'user',
                      passwordFile: credentialFile,
                      caFile,
                    },
                  ],
                },
              }
              timer = setInterval(
                () =>
                  remote.publishReport({
                    data: { state: 'printing', progress: 25 },
                  }),
                50,
              )
              beforeFirmware = async () => {
                await waitFor(() => !!probe.read()?.printers.length)
                assert.equal(probe.read()?.printers[0]?.firmware, undefined)
                remote.publishReport({ data: { version: 'A1' } })
              }
              expected = { current: 'A1' }
              assertReads = () => assert.deepEqual(remote.requests, [])
            }
            const version =
              vendor === 'moonraker'
                ? 1
                : vendor === 'bambu'
                  ? 3
                  : vendor === 'creality'
                    ? 4
                    : 5
            const origin = 'https://127.0.0.1:1'
            const configPath = join(directory, 'config.json'),
              credentialPath = join(directory, 'credential.json')
            writeFileSync(
              configPath,
              JSON.stringify({
                version,
                collection,
                assignments: [assignmentConfig],
                telemetry: {
                  endpoint: origin + '/api/connector/telemetry',
                  audience: 'fixture',
                },
                signalling: {
                  origin,
                  audience: 'fixture',
                  endpoint:
                    origin.replace('https:', 'wss:') +
                    '/api/signalling/connector',
                },
              }),
              { mode: 0o600 },
            )
            writeFileSync(
              credentialPath,
              JSON.stringify({
                version: 1,
                expected_fingerprint: identity.fingerprint,
                approval: {
                  status: 'approved',
                  agent_id: agent,
                  farm_id: farm,
                  device_token:
                    'e30.' +
                    Buffer.from(JSON.stringify({ jti: randomUUID() })).toString(
                      'base64url',
                    ) +
                    '.AA',
                  expires_at: Date.now() + 60000,
                },
              }),
              { mode: 0o600 },
            )
            running = runConnectorAgent({
              configPath,
              credentialPath,
              dataDirectory: directory,
              signal: controller.signal,
              onDiagnostic() {},
            }).catch((error) => {
              failure = error
            })
            await beforeFirmware()
            await waitFor(() => {
              if (failure) throw failure
              return (
                JSON.stringify(probe.read()?.printers[0]?.firmware) ===
                JSON.stringify(expected)
              )
            })
            assert.deepEqual(probe.read()?.printers[0]?.firmware, expected)
            await delay(1100)
            assert.deepEqual(probe.read()?.printers[0]?.firmware, expected)
            assertReads()
          } finally {
            clearInterval(timer)
            controller.abort()
            await running
            for (const close of cleanup.reverse()) await close()
            rmSync(directory, { recursive: true, force: true })
          }
        })
    } finally {
      hooks.deregister()
      Reflect.deleteProperty(globalThis, 'firmwareProbe')
    }
  },
)

async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'agent snapshot deadline')
    await delay(10)
  }
}
