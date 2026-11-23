// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from 'vitest'
import {
  assemblePrinterDetailFrames,
  decodePrinterDetailFrame,
  PrinterDetailStreamUpdate,
} from '../../packages/farm-protocol/src/printer-detail.ts'
import {
  createMoonrakerDetailStream,
  DETAIL_MIN_INTERVAL_MS,
  MoonrakerRpcError,
  type MoonrakerDetailStream,
} from '../../packages/connector/src/moonraker/detail-stream.ts'
import { createPrinterDetailSession } from '../../packages/connector/src/runtime/printer-detail-session.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockInstance,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

const KEY = 'printer-a'
const limits = {
  maxMessageBytes: 1_048_576,
  connectTimeoutMs: 1500,
  requestTimeoutMs: 1500,
  staleAfterMs: 5000,
  reconnectMinMs: 40,
  reconnectMaxMs: 160,
}

let mock: MoonrakerMockInstance
const cleanups: Array<() => void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  await mock?.close()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(read: () => T | undefined | false, ms = 3000) {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out')
    await sleep(10)
  }
}
const calls = (name: string) => mock.calls()[name] ?? 0

async function start(options: Parameters<typeof startMoonrakerMock>[0] = {}) {
  mock = await startMoonrakerMock(options)
  return createMoonrakerDetailStream({
    printerKey: KEY,
    origin: mock.origin,
    limits,
  })
}

type Frame = { t: string; [key: string]: any }
function watch(stream: MoonrakerDetailStream) {
  const frames: Array<Frame & { at: number }> = []
  const stop = stream.subscribe((frame) =>
    frames.push({ ...(frame as Frame), at: performance.now() }),
  )
  cleanups.push(stop)
  return {
    frames,
    stop,
    updates: () => frames.filter((f) => f.t === 'detail.update'),
  }
}
const heater = (frame: Frame, name: string) =>
  frame.detail.heaters.find((item: { name: string }) => item.name === name)

describe('Moonraker detail stream', () => {
  it('subscribes once, normalises to a valid E18.2 update', async () => {
    const stream = await start()
    const { updates } = watch(stream)
    const first = await until(() => updates()[0])
    const { at: _at, ...frame } = first
    expect(PrinterDetailStreamUpdate.safeParse(frame).success).toBe(true)
    expect(first.printerKey).toBe(KEY)
    expect(first.capabilities).toEqual(
      expect.arrayContaining(['heaters', 'fans', 'motion', 'job', 'console']),
    )
    expect(first.detail.toolhead.position).toHaveLength(4)
    expect(heater(first, 'extruder')).toMatchObject({ target: 0 })
    expect(heater(first, 'heater_bed')).toBeDefined()
    expect(calls('printer.objects.list')).toBe(1)
    expect(calls('printer.objects.subscribe')).toBe(1)
  })

  it('forwards status updates', async () => {
    const stream = await start()
    const { updates } = watch(stream)
    await until(() => updates()[0])
    mock.control.update({ bed: 61, bedTarget: 60 })
    const next = await until(() =>
      updates().find((f) => heater(f, 'heater_bed').temperature === 61),
    )
    expect(heater(next, 'heater_bed').target).toBe(60)
    expect(next.seq).toBeGreaterThan(updates()[0]!.seq)
  })

  it('throttles to 4 Hz under a burst of changes', async () => {
    const stream = await start()
    const { updates } = watch(stream)
    await until(() => updates()[0])
    const before = updates().length
    const startedAt = performance.now()
    for (let i = 1; i <= 60; i++) {
      mock.control.update({ bed: 20 + i })
      await sleep(10)
    }
    await until(() =>
      updates().find((frame) => heater(frame, 'heater_bed').temperature === 80),
    )
    await sleep(DETAIL_MIN_INTERVAL_MS + 50)
    const elapsed = performance.now() - startedAt
    const burst = updates().slice(before - 1)
    expect(burst.length).toBeLessThanOrEqual(
      Math.ceil(elapsed / DETAIL_MIN_INTERVAL_MS) + 2,
    )
    for (let index = burst.length - 1; index >= 0; index--)
      if (burst[index]!.at - startedAt > DETAIL_MIN_INTERVAL_MS * 3)
        burst.splice(index, 1)
    // 60 changes over ~600+ ms: at most one frame per 250 ms plus the trailing one.
    expect(burst.length).toBeLessThanOrEqual(5)
    for (let i = 1; i < burst.length; i++)
      expect(burst[i]!.at - burst[i - 1]!.at).toBeGreaterThanOrEqual(
        DETAIL_MIN_INTERVAL_MS - 15,
      )
    expect(heater(updates().at(-1)!, 'heater_bed').temperature).toBe(80)
  })

  it('forwards G-code console lines', async () => {
    const stream = await start()
    const { frames, updates } = watch(stream)
    await until(() => updates()[0])
    await fetch(mock.origin + '/printer/gcode/script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'M118 hello console' }),
    })
    const response = await until(() =>
      frames.find((f) => f.t === 'detail.gcode_response'),
    )
    expect(response.lines.join('\n')).toContain('hello console')
  })

  it('resubscribes after the connection drops', async () => {
    const stream = await start()
    const { updates } = watch(stream)
    await until(() => updates()[0])
    const seen = updates().length
    mock.control.disconnectClients()
    await until(() => calls('printer.objects.subscribe') === 2)
    await until(() => updates().length > seen)
    mock.control.update({ bed: 77 })
    await until(() =>
      updates().find((f) => heater(f, 'heater_bed').temperature === 77),
    )
  })

  it('creates no Moonraker load until watched and none after unsubscribe', async () => {
    const stream = await start()
    await sleep(150)
    expect(calls('printer.objects.subscribe') ?? 0).toBe(0)
    expect(calls('printer.objects.list') ?? 0).toBe(0)
    expect(stream.active).toBe(false)

    const { stop, updates } = watch(stream)
    await until(() => updates()[0])
    stop()
    expect(stream.active).toBe(false)
    const seen = updates().length
    const settled = { ...mock.calls() }
    mock.control.update({ bed: 99 })
    mock.control.disconnectClients()
    await sleep(limits.reconnectMinMs * 6)
    expect(updates()).toHaveLength(seen)
    expect(mock.calls()).toEqual(settled)
    await expect(stream.request('server.history.totals')).rejects.toThrow(
      MoonrakerRpcError,
    )
  })

  it('keeps one connection while any listener remains', async () => {
    const stream = await start()
    const a = watch(stream)
    const b = watch(stream)
    await until(() => a.updates()[0] && b.updates()[0])
    a.stop()
    mock.control.update({ bed: 55 })
    await until(() =>
      b.updates().find((f) => heater(f, 'heater_bed').temperature === 55),
    )
    expect(calls('printer.objects.subscribe')).toBe(1)
    b.stop()
    expect(stream.active).toBe(false)
  })
})

function session(
  stream: Pick<MoonrakerDetailStream, never> | MoonrakerDetailStream,
) {
  const wires: Frame[] = []
  const detail = createPrinterDetailSession(
    (key) => (key === KEY ? (stream as MoonrakerDetailStream) : undefined),
    (key) => key === KEY,
    (batch) => {
      // A message over the 2048-byte application cap arrives as one batch of
      // ordered chunks; the browser assembles it before use.
      if (batch.length > 1)
        wires.push(assemblePrinterDetailFrames(batch) as Frame)
      else
        for (const wire of batch)
          wires.push(decodePrinterDetailFrame(wire) as Frame)
    },
  )
  cleanups.push(() => detail.close())
  const send = (frame: object) =>
    detail.receive(JSON.stringify({ v: 1, printerKey: KEY, ...frame }))
  const response = (requestId: string) =>
    until(() =>
      wires.find((f) => f.t === 'query.response' && f.requestId === requestId),
    )
  return { wires, detail, send, response }
}

describe('printer detail session queries', () => {
  it('starts on detail.subscribe and releases on detail.unsubscribe', async () => {
    const stream = await start()
    const { wires, send } = session(stream)
    expect(send({ t: 'detail.subscribe' })).toBe(true)
    await until(() => wires.find((f) => f.t === 'detail.update'))
    expect(stream.active).toBe(true)
    send({ t: 'detail.unsubscribe' })
    expect(stream.active).toBe(false)
  })

  it('closing the session releases the stream', async () => {
    const stream = await start()
    const { wires, send, detail } = session(stream)
    send({ t: 'detail.subscribe' })
    await until(() => wires.find((f) => f.t === 'detail.update'))
    detail.close()
    expect(stream.active).toBe(false)
  })

  it('ignores queries while not subscribed', async () => {
    const stream = await start()
    const { wires, send } = session(stream)
    send({ t: 'query.request', requestId: 'q0', kind: 'totals' })
    await sleep(100)
    expect(wires).toHaveLength(0)
    expect(calls('server.history.totals') ?? 0).toBe(0)
  })

  it('pages history across Moonraker requests', async () => {
    const stream = await start()
    for (let i = 0; i < 70; i++) {
      mock.control.update({ state: 'printing', filename: `job-${i}.gcode` })
      mock.control.update({ state: 'complete' })
    }
    const { wires, send, response } = session(stream)
    send({ t: 'detail.subscribe' })
    await until(() => wires.find((f) => f.t === 'detail.update'))
    send({ t: 'query.request', requestId: 'h', kind: 'history' })
    const reply = await response('h')
    expect(reply.data).toHaveLength(70)
    expect(reply.data[0]).toMatchObject({ state: 'completed' })
    expect(calls('server.history.list')).toBe(2)
  })

  it('answers files, totals and temperature backfill', async () => {
    const stream = await start({
      files: [{ path: 'benchy.gcode', size: 123, modified: 1_700_000_000 }],
    })
    for (let i = 1; i <= 5; i++) mock.control.update({ bed: 20 + i })
    const { wires, send, response } = session(stream)
    send({ t: 'detail.subscribe' })
    await until(() => wires.find((f) => f.t === 'detail.update'))
    for (const kind of ['files', 'totals', 'temperature-store'])
      send({ t: 'query.request', requestId: kind, kind })
    const files = await response('files')
    expect(files.data).toEqual([
      { path: 'benchy.gcode', bytes: 123, modifiedAtMs: 1_700_000_000_000 },
    ])
    expect((await response('totals')).data).toMatchObject({ jobs: 0 })
    const store = (await response('temperature-store')).data as Array<{
      name: string
      samples: Array<{ atMs: number; temperature: number }>
    }>
    const bed = store.find((item) => item.name === 'heater_bed')!
    expect(bed.samples.length).toBeGreaterThanOrEqual(5)
    expect(bed.samples.at(-1)!.temperature).toBe(25)
    const times = bed.samples.map((s) => s.atMs)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('rejects traversal in config-read as unavailable', async () => {
    const stream = await start()
    const { wires, send, response } = session(stream)
    send({ t: 'detail.subscribe' })
    await until(() => wires.find((f) => f.t === 'detail.update'))
    send({
      t: 'query.request',
      requestId: 'c',
      kind: 'config-read',
      path: '../printer.cfg',
    })
    expect(await response('c')).toMatchObject({ error: 'unavailable' })
  })

  it('maps a missing Moonraker component to unsupported', async () => {
    const stream = await start()
    const failing = {
      ...stream,
      request: () => Promise.reject(new MoonrakerRpcError('missing', -32601)),
    } as MoonrakerDetailStream
    const { wires, send, response } = session(failing)
    send({ t: 'detail.subscribe' })
    await until(() => wires.find((f) => f.t === 'detail.update'))
    send({ t: 'query.request', requestId: 'u', kind: 'timelapse' })
    expect(await response('u')).toMatchObject({ error: 'unsupported' })
  })
})
