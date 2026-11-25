// Slow read-only vendors (#875) and collector hardening (#886). Loopback
// simulators and synthetic payloads only; no printer is contacted.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { formatPrinterStateLabel } from '../../apps/farm/app/utils/farm-view.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { createFlashforgeCollection } from '../../packages/connector/src/flashforge/collection.ts'
import { createPhrozenCollection } from '../../packages/connector/src/phrozen/collection.ts'
import { parseCollectorConfig } from '../../packages/connector/src/prusa/config.ts'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import {
  createFarmSnapshotSource,
  type RawPrinterObservation,
  type RawPrinterUnavailable,
} from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { createQidiCollection } from '../../packages/connector/src/runtime/qidi-collection.ts'
import type {
  CompleteFarmSnapshot,
  FarmSnapshotProvider,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import { startFlashforgeSimulator } from '../../packages/sim-tools/src/flashforge-simulator.ts'
import { startPhrozenSimulator } from '../../packages/sim-tools/src/phrozen-simulator.ts'
import { startQidiSimulator } from '../../packages/sim-tools/src/qidi-simulator.ts'

const json = async (path: string) =>
  (await import(`../fixtures/${path}`, { with: { type: 'json' } })).default
const qidiFixture = await json('qidi/moonraker.json')
const flashFixture = await json('flashforge/detail.json')
const phrozenFixture = await json('phrozen/synthetic-revo-14k-v153.json')

async function until(check: () => boolean, ms = 4000) {
  const end = performance.now() + ms
  while (!check()) {
    assert.ok(performance.now() < end, 'condition not reached in time')
    await delay(10)
  }
}

function directory(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'rv-snapshot-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function farm(t: TestContext, keys: string[]) {
  const agent = randomUUID()
  const refs = keys.map((printerKey) => ({
    assignmentId: randomUUID(),
    agentId: agent,
    printerKey,
  }))
  let now = 100
  const source = createFarmSnapshotSource({
    assignmentRefs: refs,
    nowMono: () => now,
  })
  const received: CompleteFarmSnapshot[] = []
  let unavailable = 0
  const controller = new AbortController()
  t.after(() => controller.abort())
  return {
    source,
    received,
    unavailable: () => unavailable,
    setNow: (value: number) => {
      now = value
    },
    open() {
      return source.open({
        binding: {
          agent_id: agent,
        } as Parameters<FarmSnapshotProvider>[0]['binding'],
        deadlineMonoMs: 60_000,
        assignmentRefs: refs,
        signal: controller.signal,
        onComplete: (value) => void received.push(value),
        onUnavailable: () => void unavailable++,
      })
    },
    healthy(printerKey: string) {
      source.observe({
        printerKey,
        epoch: 1,
        printer: {
          printerKey,
          state: 'printing',
          progress: 0.2,
          observedAt: 10,
        },
        status: {
          webhooks: { state: 'ready' },
          print_stats: { state: 'printing' },
          virtual_sdcard: { progress: 0.2 },
        },
        fieldObservedAtMonoMs: {
          webhooks: now,
          printState: now,
          progress: now,
        },
        receivedAtMonoMs: now,
      })
    },
    qidi(printerKey: string, epoch = 1) {
      source.observe({
        printerKey,
        epoch,
        printer: {
          printerKey,
          state: 'printing',
          progress: 0.5,
          identity: { vendor: 'Qidi' },
          statusReason: 'qidi-unqualified',
          observedAt: 20,
        },
        receivedAtMonoMs: now,
        fieldObservedAtMonoMs: {
          qidi: {
            state: now,
            progress: now,
            identity: now,
            statusReason: now,
          },
        },
      })
    },
  }
}

const states = (value: CompleteFarmSnapshot | undefined) =>
  value?.printers.map((printer) => [printer.printerKey, printer.state])

test('#875 a slow read-only printer expires alone among healthy printers', (t) => {
  const f = farm(t, ['healthy', 'slow'])
  f.healthy('healthy')
  f.qidi('slow')
  f.open()
  assert.deepEqual(states(f.received.at(-1)), [
    ['healthy', 'printing'],
    ['slow', 'printing'],
  ])
  f.setNow(5200)
  f.healthy('healthy')
  assert.equal(f.unavailable(), 0)
  const stale = f.received.at(-1)!
  assert.deepEqual(states(stale), [
    ['healthy', 'printing'],
    ['slow', 'unknown'],
  ])
  assert.equal(stale.printers[1]!.progress, undefined)
  assert.deepEqual(stale.printers[1]!.controls, [])
  assert.equal(stale.capturedAtMonoMs, 5200)
  assert.equal(stale.validUntilMonoMs, 10_200)
  f.setNow(5300)
  f.qidi('slow')
  assert.deepEqual(states(f.received.at(-1)), [
    ['healthy', 'printing'],
    ['slow', 'printing'],
  ])
})

test('#875 read-only expiry republishes early; a farm with nothing current closes', (t) => {
  const f = farm(t, ['a', 'b'])
  f.qidi('a')
  f.setNow(2000)
  f.qidi('b')
  f.open()
  assert.equal(f.received.at(-1)!.validUntilMonoMs, 7000)
  f.source.invalidate({
    printerKey: 'a',
    epoch: 1,
    readOnly: { family: 'qidi', simulated: false },
  })
  assert.deepEqual(states(f.received.at(-1)), [
    ['a', 'unknown'],
    ['b', 'printing'],
  ])
  assert.equal(f.unavailable(), 0)
  f.source.invalidate({
    printerKey: 'b',
    epoch: 1,
    readOnly: { family: 'qidi', simulated: false },
  })
  assert.equal(f.unavailable(), 1)
})

test('#875 a read-only printer that never answered does not hide the farm', (t) => {
  const f = farm(t, ['healthy', 'silent'])
  f.healthy('healthy')
  f.source.invalidate({
    printerKey: 'silent',
    epoch: 1,
    readOnly: { family: 'flashforge', simulated: true },
  })
  f.open()
  assert.equal(f.unavailable(), 0)
  assert.equal(f.received.at(-1)!.printers[1]!.state, 'unknown')
  assert.equal(
    f.received.at(-1)!.printers[1]!.statusReason,
    'flashforge-simulated',
  )
  // The stale epoch cannot come back.
  f.qidi('silent', 1)
  assert.equal(f.received.at(-1)!.printers[1]!.state, 'unknown')
})

test('#875 the collector marks read-only vendor withdrawals', async (t) => {
  const dir = directory(t)
  const simulator = await startQidiSimulator({
    ...qidiFixture,
    snapshot: new Uint8Array(),
  })
  t.after(() => simulator.close())
  const queue = new TelemetryQueue(join(dir, 'queue'), Date.now())
  const controller = new AbortController()
  const events: RawPrinterUnavailable[] = []
  const run = collectIntoQueue({
    config: parseCollectorConfig({
      version: 8,
      printers: [],
      allowedOrigins: [simulator.origin],
      drivers: [
        {
          family: 'qidi',
          printerKey: 'qidi',
          origin: simulator.origin,
          simulated: true,
          expect: { moonrakerVersion: 'wrong' },
          auth: { kind: 'trusted-lan' },
        },
      ],
      limits: { requestTimeoutMs: 500 },
    }),
    queue,
    signal: controller.signal,
    onDiagnostic() {},
    onRawUnavailable: (event) => events.push(event),
  })
  try {
    await until(() => events.length > 0)
    assert.deepEqual(events[0], {
      printerKey: 'qidi',
      epoch: 1,
      readOnly: { family: 'qidi', simulated: true },
    })
  } finally {
    controller.abort()
    await run
    queue.close()
  }
})

test('#875 a slow vendor answer is replaced before it expires', async (t) => {
  const server = createServer((request, response) => {
    setTimeout(() => {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify(
            request.url === '/server/info'
              ? qidiFixture.info
              : qidiFixture.state,
          ),
        )
    }, 1600)
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const controller = new AbortController()
  const received: number[] = []
  const withdrawn: number[] = []
  const collection = createQidiCollection({
    binding: {
      family: 'qidi',
      printerKey: 'slow',
      origin,
      simulated: true,
      expect: { moonrakerVersion: 'v0.8.0' },
      auth: { kind: 'trusted-lan' },
    },
    allowedOrigins: [origin],
    signal: controller.signal,
    timeoutMs: 3000,
    onObservation: (value) => received.push(value.receivedAtMonoMs),
    onUnavailable: (epoch) => withdrawn.push(epoch),
  })
  try {
    await until(() => received.length === 2, 12_000)
    assert.ok(received[1]! - received[0]! < 5000)
    assert.deepEqual(withdrawn, [])
  } finally {
    controller.abort()
    await collection.done
  }
})

async function anycubic(t: TestContext) {
  const passwordFile = join(directory(t), 'password.json')
  writeFileSync(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const controller = new AbortController()
  let report: (payload: unknown) => void = () => {}
  const observations: RawPrinterObservation[] = []
  const collection = createAnycubicCollection({
    binding: {
      printerKey: 'a',
      host: '127.0.0.1',
      port: 9883,
      modelId: '20024',
      deviceId: 'SYNTHETIC',
      username: 'test',
      passwordFile,
    },
    signal: controller.signal,
    onObservation: (value) => observations.push(value),
    onUnavailable() {},
    transport(options) {
      report = (payload) =>
        options.onReport(Buffer.from(JSON.stringify(payload)))
      return { done: Promise.resolve(), close: async () => {} }
    },
  })
  t.after(async () => {
    controller.abort()
    await collection.done
  })
  return { observations, report: (payload: unknown) => report(payload) }
}

for (const [wire, state] of [
  ['stoped', 'error'],
  ['paused', 'paused'],
] as const) {
  test(`#886 a first ${state} fault is published without progress`, async (t) => {
    const printer = await anycubic(t)
    printer.report({
      type: 'print',
      action: 'stop',
      state: wire,
      code: 10111,
      msg: 'abnormal end of task',
    })
    const observation = printer.observations.at(-1)
    assert.equal(observation?.printer.state, state)
    assert.equal(observation.printer.progress, undefined)
    assert.match(observation.printer.statusMessage!, /10111/)
    // The fault also survives the live farm snapshot.
    const agent = randomUUID()
    const refs = [
      { assignmentId: randomUUID(), agentId: agent, printerKey: 'a' },
    ]
    const source = createFarmSnapshotSource({ assignmentRefs: refs })
    source.observe(observation)
    let published: CompleteFarmSnapshot | undefined
    source
      .open({
        binding: {
          agent_id: agent,
        } as Parameters<FarmSnapshotProvider>[0]['binding'],
        deadlineMonoMs: performance.now() + 2000,
        assignmentRefs: refs,
        signal: new AbortController().signal,
        onComplete: (value) => void (published = value),
        onUnavailable() {},
      })
      .close()
    source.close()
    assert.equal(published?.printers[0]?.state, state)
  })
}

for (const [wire, code, expected] of [
  ['stoped', 10601, 0],
  ['stoped', 10111, undefined],
] as const) {
  test(`#886 a print-report stop with code ${code} drops the old progress`, async (t) => {
    const printer = await anycubic(t)
    printer.report({
      data: {
        state: 'printing',
        progress: 40,
        curr_layer: 3,
        total_layers: 9,
      },
    })
    assert.equal(printer.observations.at(-1)?.printer.progress, 0.4)
    printer.report({ type: 'print', action: 'stop', state: wire, code })
    const stopped = printer.observations.at(-1)!.printer
    assert.equal(stopped.progress, expected)
    assert.equal(stopped.currentLayer, undefined)
    assert.equal(stopped.totalLayer, undefined)
    // A later bare idle report is still published, from zero.
    printer.report({ data: { state: 'free', project: null } })
    const idle = printer.observations.at(-1)!.printer
    assert.equal(idle.state, 'idle')
    assert.equal(idle.progress, 0)
  })
}

test('#886 only a flagged fault with a message may omit progress', () => {
  const value = {
    printerKey: 'a',
    state: 'error',
    statusReason: 'printer-fault',
    statusMessage: 'falha',
    observedAt: 1,
  }
  assert.equal(PrinterState.safeParse(value).success, true)
  for (const patch of [
    { statusMessage: undefined },
    { statusReason: undefined },
    { state: 'idle' },
    { state: 'printing' },
  ])
    assert.equal(PrinterState.safeParse({ ...value, ...patch }).success, false)
})

test('#886 every read-only status reason has a pt-BR label', () => {
  for (const vendor of ['flashforge', 'phrozen', 'qidi'] as const) {
    assert.equal(
      formatPrinterStateLabel({
        state: 'idle',
        statusReason: `${vendor}-simulated`,
      }),
      'Ociosa — dados de simulador',
    )
    assert.equal(
      formatPrinterStateLabel({
        state: 'unknown',
        statusReason: `${vendor}-unqualified`,
      }),
      'Estado da impressora desconhecido — somente leitura, não qualificada em hardware',
    )
  }
})

function flashBinding(t: TestContext, origin: string) {
  const credentialFile = join(directory(t), 'flash.json')
  writeFileSync(
    credentialFile,
    JSON.stringify({
      origin,
      serialNumber: 'FIXTURE-SERIAL',
      checkCode: 'FIXTURE-CODE',
    }),
    { mode: 0o600 },
  )
  return {
    family: 'flashforge' as const,
    printerKey: 'flash',
    origin,
    credentialFile,
    simulated: true,
    expect: {
      serialNumber: 'FIXTURE-SERIAL',
      model: 'Adventurer 5M Pro' as const,
    },
  }
}

test('#886 a throwing Flashforge observation callback keeps collecting', async (t) => {
  const simulator = await startFlashforgeSimulator((_request, response) => {
    response.end(JSON.stringify(flashFixture))
  })
  t.after(() => simulator.close())
  const origin = `http://${simulator.host}:${simulator.port}`
  const controller = new AbortController()
  let calls = 0
  const withdrawn: number[] = []
  const collection = createFlashforgeCollection({
    binding: flashBinding(t, origin),
    allowedOrigins: [origin],
    signal: controller.signal,
    timeoutMs: 500,
    onObservation() {
      if (++calls === 1) throw Error('consumer failed')
    },
    onUnavailable: (epoch) => withdrawn.push(epoch),
  })
  // Observe the rejection now; the assertion below would otherwise leak it.
  let failed: unknown
  const done = collection.done.catch((error: unknown) => (failed = error))
  try {
    await until(() => calls === 2 || failed !== undefined)
    assert.equal(failed, undefined)
    assert.deepEqual(withdrawn, [1])
  } finally {
    controller.abort()
    await done
  }
})

const phrozenBinding = (udpPort: number, wsPort: number) => ({
  family: 'phrozen' as const,
  printerKey: 'revo',
  origin: `ws://127.0.0.1:${wsPort}`,
  discoveryPort: udpPort,
  simulated: true,
  expect: {
    id: phrozenFixture.Id,
    board: phrozenFixture.Data.MainboardID,
    model: 'Sonic Mighty Revo 14K' as const,
    firmware: 'V153' as const,
  },
})

async function abortsPromptly(
  start: (signal: AbortSignal) => { done: Promise<void> },
  requested: () => boolean,
) {
  const controller = new AbortController()
  const collection = start(controller.signal)
  await until(requested)
  const before = performance.now()
  controller.abort()
  await collection.done
  assert.ok(performance.now() - before < 1000, 'shutdown waited for timeout')
}

const events = { onObservation() {}, onUnavailable() {} }

for (const family of ['qidi', 'flashforge'] as const) {
  test(`#886 shutdown aborts a pending ${family} request`, async (t) => {
    let requests = 0
    const server = createServer(() => void requests++)
    await once(server.listen(0, '127.0.0.1'), 'listening')
    t.after(() => {
      server.closeAllConnections()
      server.close()
    })
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const shared = { allowedOrigins: [origin], timeoutMs: 3000, ...events }
    await abortsPromptly(
      (signal) =>
        family === 'flashforge'
          ? createFlashforgeCollection({
              ...shared,
              signal,
              binding: flashBinding(t, origin),
            })
          : createQidiCollection({
              ...shared,
              signal,
              binding: {
                family: 'qidi',
                printerKey: 'qidi',
                origin,
                simulated: true,
                expect: { moonrakerVersion: 'v0.8.0' },
                auth: { kind: 'trusted-lan' },
              },
            }),
      () => requests > 0,
    )
  })
}

test('#886 shutdown aborts a pending Phrozen discovery and status request', async (t) => {
  let datagrams = 0
  const udp = createSocket('udp4')
  udp.on('message', () => void datagrams++)
  await once(udp.bind(0, '127.0.0.1'), 'listening')
  t.after(() => udp.close())
  const mute = phrozenBinding(udp.address().port, 3030)
  await abortsPromptly(
    (signal) =>
      createPhrozenCollection({
        binding: mute,
        allowedOrigins: [mute.origin],
        signal,
        timeoutMs: 3000,
        ...events,
      }),
    () => datagrams > 0,
  )
  const simulator = await startPhrozenSimulator(
    structuredClone(phrozenFixture),
    'timeout',
  )
  t.after(() => simulator.close())
  const binding = phrozenBinding(simulator.udpPort, simulator.wsPort)
  await abortsPromptly(
    (signal) =>
      createPhrozenCollection({
        binding,
        allowedOrigins: [binding.origin],
        signal,
        timeoutMs: 3000,
        ...events,
      }),
    () => simulator.commands.length > 0,
  )
})

test('#886 Qidi reads its credential once until a poll fails', async (t) => {
  const simulator = await startQidiSimulator({
    ...qidiFixture,
    snapshot: new Uint8Array(),
  })
  t.after(() => simulator.close())
  const { origin } = simulator
  const credentialFile = join(directory(t), 'qidi.json')
  writeFileSync(
    credentialFile,
    JSON.stringify({ origin, secret: 'fixture-key' }),
    { mode: 0o600 },
  )
  const controller = new AbortController()
  let observations = 0
  const withdrawn: number[] = []
  const collection = createQidiCollection({
    binding: {
      family: 'qidi',
      printerKey: 'qidi',
      origin,
      simulated: true,
      expect: { moonrakerVersion: 'v0.8.0' },
      auth: { kind: 'api-key', credentialFile },
    },
    allowedOrigins: [origin],
    signal: controller.signal,
    timeoutMs: 500,
    onObservation: () => void observations++,
    onUnavailable: (epoch) => withdrawn.push(epoch),
  })
  try {
    await until(() => observations === 1)
    rmSync(credentialFile)
    await until(() => observations === 2)
    assert.deepEqual(withdrawn, [])
    simulator.setFault('disconnect')
    await until(() => withdrawn.length === 1)
    simulator.setFault(undefined)
    const sent = simulator.requests.length
    await delay(1500)
    // The failure dropped the cached key and the file is gone.
    assert.equal(simulator.requests.length, sent)
  } finally {
    controller.abort()
    await collection.done
  }
})

test('#886 Phrozen keeps one status socket across polls', async (t) => {
  const simulator = await startPhrozenSimulator(structuredClone(phrozenFixture))
  t.after(() => simulator.close())
  const Original = globalThis.WebSocket
  const sockets: WebSocket[] = []
  globalThis.WebSocket = class extends Original {
    constructor(url: string | URL) {
      super(url)
      sockets.push(this)
    }
  }
  t.after(() => {
    globalThis.WebSocket = Original
  })
  const binding = phrozenBinding(simulator.udpPort, simulator.wsPort)
  const controller = new AbortController()
  let observations = 0
  const collection = createPhrozenCollection({
    binding,
    allowedOrigins: [binding.origin],
    signal: controller.signal,
    timeoutMs: 500,
    pollMs: 10,
    onObservation: () => void observations++,
    onUnavailable() {},
  })
  try {
    await until(() => observations >= 3)
    assert.equal(sockets.length, 1)
    simulator.setFault('denied')
    await delay(50)
    simulator.setFault()
    const seen = observations
    await until(() => observations > seen)
    assert.ok(sockets.length > 1, 'a failed poll drops the socket')
  } finally {
    controller.abort()
    await collection.done
  }
  await until(() => sockets.every((s) => s.readyState === Original.CLOSED))
})
