import { describe, test, expect, vi } from 'vitest'
import {
  parseIdentifyResult,
  parseServerInfoResult,
  parseToolStatus,
  parseWebcamsResult,
  selectToolObjects,
  MAX_TOOLS,
  MAX_WEBCAMS,
} from '../../packages/connector/src/moonraker/discovery-parse.ts'
import { discoverMoonraker } from '../../packages/connector/src/moonraker/discovery.ts'
import { serveWsTestServer } from './ws-serve.ts'

// Hand-written from the Moonraker API docs (no real capture); 4 tools mirror
// infra/sim/u1/tools.cfg: extruder, extruder1..3.
const origin = 'http://127.0.0.1:7125'
const objectList = {
  objects: [
    'webhooks',
    'toolhead',
    'extruder',
    'extruder1',
    'extruder2',
    'extruder3',
    'heater_bed',
    'extruder01',
    'extruderX',
    42,
  ],
}
const toolsStatus = {
  toolhead: { extruder: 'extruder2' },
  extruder: { temperature: 210.5, target: 215 },
  extruder1: { temperature: 25, target: 0 },
  extruder2: { temperature: 'hot', target: 0 },
  extruder3: { temperature: 24.8, target: 0 },
  heater_bed: { temperature: 60, target: 60 },
}
const webcamList = {
  webcams: [
    {
      uid: 'a1',
      name: 'u1',
      enabled: true,
      service: 'mjpegstreamer',
      stream_url: '/webcam/?action=stream',
      snapshot_url: '/webcam/?action=snapshot',
      target_fps: 15,
      rotation: 90,
      flip_horizontal: true,
    },
    {
      name: 'foreign',
      snapshot_url: 'http://evil.example/snap',
      stream_url: 'http://u:p@127.0.0.1:7125/x',
    },
    { name: '', snapshot_url: '/x' },
    'junk',
  ],
}

describe('discovery parsers', () => {
  test('identify and server info', () => {
    expect(parseIdentifyResult({ connection_id: 1234 })).toEqual({
      connectionId: 1234,
    })
    expect(() => parseIdentifyResult({ connection_id: -1 })).toThrow()
    expect(() => parseIdentifyResult({})).toThrow()
    const info = parseServerInfoResult({
      klippy_connected: true,
      klippy_state: 'ready',
      moonraker_version: 'v0.9.3',
      api_version: [1, 5, 0],
      components: ['a'],
    })
    expect(info).toMatchObject({
      ready: true,
      klippyState: 'ready',
      apiVersion: [1, 5, 0],
    })
    expect(
      parseServerInfoResult({
        klippy_connected: true,
        klippy_state: 'startup',
        api_version: 'x',
      }),
    ).toMatchObject({
      ready: false,
      apiVersion: null,
    })
    expect(() =>
      parseServerInfoResult({ klippy_connected: true, klippy_state: 'weird' }),
    ).toThrow()
  })

  test('tool objects selected, ordered and capped', () => {
    expect(selectToolObjects(objectList)).toEqual([
      'extruder',
      'extruder1',
      'extruder2',
      'extruder3',
    ])
    const many = {
      objects: Array.from({ length: 100 }, (_, i) =>
        i ? `extruder${i}` : 'extruder',
      ),
    }
    expect(selectToolObjects(many)).toHaveLength(MAX_TOOLS)
    expect(() => selectToolObjects({ objects: 'x' })).toThrow()
  })

  test('multi-tool status normalizes active tool, drops malformed readings', () => {
    const status = parseToolStatus(toolsStatus)
    expect(status.activeObject).toBe('extruder2')
    expect(status.tools.map((t) => [t.index, t.active, t.celsius])).toEqual([
      [0, false, 210.5],
      [1, false, 25],
      [2, true, null],
      [3, false, 24.8],
    ])
    expect(
      parseToolStatus({ extruder: { temperature: 1e9 } }).tools[0]!.celsius,
    ).toBeNull()
    expect(parseToolStatus({}).activeObject).toBeNull()
    expect(() => parseToolStatus(null)).toThrow()
  })

  test('webcams: relative paths resolve only against the explicit webcam origin', () => {
    const frontend = 'http://127.0.0.1' // nginx :80, not Moonraker :7125
    const cams = parseWebcamsResult(webcamList, frontend)
    expect(cams).toHaveLength(2)
    expect(cams[0]).toMatchObject({
      name: 'u1',
      snapshotPath: '/webcam/?action=snapshot',
      snapshotUrl: 'http://127.0.0.1/webcam/?action=snapshot',
      streamUrl: 'http://127.0.0.1/webcam/?action=stream',
      rotation: 90,
      targetFps: 15,
      flipHorizontal: true,
    })
    // Foreign absolute and userinfo URLs are dropped.
    expect(cams[1]).toMatchObject({
      name: 'foreign',
      snapshotUrl: null,
      snapshotPath: null,
      streamUrl: null,
    })
    // Without a webcam origin nothing is resolved against Moonraker's own port.
    const raw = parseWebcamsResult(webcamList, null)[0]!
    expect(raw).toMatchObject({
      snapshotPath: '/webcam/?action=snapshot',
      snapshotUrl: null,
      streamUrl: null,
    })
  })

  test.each([
    ['protocol-relative', '//evil.example/snap'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/plain,hi'],
    ['backslash', '/a\\b'],
    ['control char', '/a\u0001b'],
    ['space', '/a b'],
    ['too long', '/' + 'a'.repeat(2048)],
    ['userinfo host confusion', 'http://127.0.0.1@evil.example/x'],
    ['userinfo', 'http://u:p@127.0.0.1/x'],
    ['port mismatch', 'http://127.0.0.1:7125/x'],
    ['scheme mismatch', 'https://127.0.0.1/x'],
    ['ftp', 'ftp://127.0.0.1/x'],
    ['bare relative', 'webcam/x'],
    ['empty', ''],
    ['number', 5],
  ])('webcam url rejected: %s', (_name, value) => {
    const [cam] = parseWebcamsResult(
      { webcams: [{ name: 'c', snapshot_url: value, stream_url: value }] },
      'http://127.0.0.1',
    )
    expect(cam).toMatchObject({
      snapshotUrl: null,
      snapshotPath: null,
      streamUrl: null,
      streamPath: null,
    })
  })

  test('webcam absolute url accepted for the exact webcam origin; count capped', () => {
    const [cam] = parseWebcamsResult(
      { webcams: [{ name: 'c', snapshot_url: 'http://127.0.0.1/snap' }] },
      'http://127.0.0.1',
    )
    expect(cam).toMatchObject({
      snapshotUrl: 'http://127.0.0.1/snap',
      snapshotPath: null,
    })
    const many = {
      webcams: Array.from({ length: 50 }, (_, i) => ({ name: `c${i}` })),
    }
    expect(parseWebcamsResult(many, null)).toHaveLength(MAX_WEBCAMS)
    expect(() => parseWebcamsResult({ webcams: 'x' }, null)).toThrow()
  })

  test('object list is not rejected for being large', () => {
    const objects = [
      'extruder',
      ...Array.from({ length: 3000 }, (_, i) => `gcode_macro M${i}`),
    ]
    expect(selectToolObjects({ objects })).toEqual(['extruder'])
  })
})

const limits = {
  maxMessageBytes: 64 * 1024,
  connectTimeoutMs: 1000,
  requestTimeoutMs: 500,
  staleAfterMs: 1000,
  reconnectMinMs: 10,
  reconnectMaxMs: 20,
}
type Reply = unknown
async function serve(replies: Record<string, Reply>) {
  const methods: string[] = []
  let opened = 0
  let closed = 0
  const server = await serveWsTestServer({
    http: () => new Response('no', { status: 404 }),
    upgrade: (request) => new URL(request.url).pathname === '/websocket',
    onOpen: () => void opened++,
    onClose: () => void closed++,
    onMessage(socket, message) {
      const { id, method } = JSON.parse(message) as {
        id: number
        method: string
      }
      methods.push(method)
      const reply = replies[method]
      if (reply === 'none') return
      if (reply === 'junk') return socket.send('{not json')
      if (reply === 'big')
        return socket.send('x'.repeat(limits.maxMessageBytes + 1))
      if (reply === 'wrongid')
        return socket.send(
          JSON.stringify({ jsonrpc: '2.0', id: id + 50, error: {} }),
        )
      if (reply === 'notify')
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notify_proc_stat_update',
            params: [{}],
          }),
        )
      socket.send(
        JSON.stringify(
          reply === 'error'
            ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } }
            : {
                jsonrpc: '2.0',
                id,
                result:
                  reply === 'notify'
                    ? base[method as keyof typeof base]
                    : reply,
              },
        ),
      )
    },
  })
  return {
    server,
    methods,
    origin: `http://127.0.0.1:${server.port}`,
    // Both sides must observe the socket gone: the discovery socket is always terminated.
    async closed() {
      await vi.waitFor(() => expect(closed).toBe(opened), { timeout: 2000 })
      expect(opened).toBeGreaterThan(0)
    },
  }
}
const client = {
  name: 'o3dfm-connector',
  version: '0.0.0',
  url: 'https://example.invalid',
}
const base = {
  'server.connection.identify': { connection_id: 7 },
  'server.info': {
    klippy_connected: true,
    klippy_state: 'ready',
    api_version: [1, 5, 0],
  },
  'printer.objects.list': objectList,
  'printer.objects.query': { eventtime: 1, status: toolsStatus },
  'server.webcams.list': webcamList,
}
// Moonraker on an ephemeral port; cameras behind the frontend host on :80.
const webcamOrigin = 'http://127.0.0.1'
const run = (
  s: { origin: string },
  extra: object = {},
  signal = AbortSignal.timeout(5000),
) => discoverMoonraker({ origin: s.origin, limits, signal, client, ...extra })
const using = async (
  replies: Record<string, Reply>,
  body: (s: Awaited<ReturnType<typeof serve>>) => Promise<void>,
) => {
  const s = await serve(replies)
  try {
    await body(s)
    await s.closed()
  } finally {
    await s.server.stop()
  }
}

describe('discoverMoonraker', () => {
  test('runs the read-only handshake in order and normalizes', () =>
    using(base, async (s) => {
      const out = await run(s, { webcamOrigin })
      expect(s.methods).toEqual([
        'server.connection.identify',
        'server.info',
        'printer.objects.list',
        'printer.objects.query',
        'server.webcams.list',
      ])
      expect(out.identity.connectionId).toBe(7)
      expect(out.server.ready).toBe(true)
      expect(out.tools.tools).toHaveLength(4)
      // Camera URL is on the frontend host, not the Moonraker port.
      expect(out.webcams[0]!.snapshotUrl).toBe(
        'http://127.0.0.1/webcam/?action=snapshot',
      )
      expect(out.webcams[0]!.snapshotUrl).not.toContain(
        String(new URL(s.origin).port),
      )
    }))

  test('without webcamOrigin only raw paths are returned', () =>
    using(base, async (s) => {
      const out = await run(s)
      expect(out.webcams[0]).toMatchObject({
        snapshotPath: '/webcam/?action=snapshot',
        snapshotUrl: null,
      })
    }))

  test('klippy not ready stops after server.info with not-ready', () =>
    using(
      {
        ...base,
        'server.info': { klippy_connected: true, klippy_state: 'startup' },
      },
      async (s) => {
        await expect(run(s)).rejects.toMatchObject({ reason: 'not-ready' })
        expect(s.methods).toEqual(['server.connection.identify', 'server.info'])
      },
    ))

  test('missing webcam component is non-fatal', () =>
    using({ ...base, 'server.webcams.list': 'error' }, async (s) => {
      expect((await run(s)).webcams).toEqual([])
    }))

  test('interleaved notification without id is ignored', () =>
    using({ ...base, 'server.info': 'notify' }, async (s) => {
      expect((await run(s)).server.ready).toBe(true)
    }))

  test.each([
    ['identify error', { ...base, 'server.connection.identify': 'error' }],
    [
      'malformed server.info',
      { ...base, 'server.info': { klippy_state: 'ready' } },
    ],
    ['junk frame', { ...base, 'printer.objects.list': 'junk' }],
    ['oversized frame', { ...base, 'printer.objects.list': 'big' }],
    ['failure reply with mismatched id', { ...base, 'server.info': 'wrongid' }],
    [
      'remote error on object query',
      { ...base, 'printer.objects.query': 'error' },
    ],
    [
      'malformed tool status',
      { ...base, 'printer.objects.query': { status: 5 } },
    ],
  ])('%s rejects invalid-response', (_name, replies) =>
    using(replies, async (s) => {
      await expect(run(s)).rejects.toMatchObject({ reason: 'invalid-response' })
    }),
  )

  test('unanswered request rejects stale and closes the socket', () =>
    using({ ...base, 'server.info': 'none' }, async (s) => {
      await expect(run(s)).rejects.toMatchObject({ reason: 'stale' })
    }))

  test('abort before start never connects; abort mid-flight rejects offline and closes', async () => {
    const pre = new AbortController()
    pre.abort()
    const idle = await serve(base)
    try {
      await expect(run(idle, {}, pre.signal)).rejects.toMatchObject({
        reason: 'offline',
      })
      expect(idle.methods).toEqual([])
    } finally {
      await idle.server.stop()
    }
    await using({ ...base, 'server.info': 'none' }, async (s) => {
      const controller = new AbortController()
      const pending = run(s, {}, controller.signal)
      setTimeout(() => controller.abort(), 100)
      await expect(pending).rejects.toMatchObject({ reason: 'offline' })
    })
  })

  test('overall deadline bounds a server that answers nothing', async () => {
    const hang = await serveWsTestServer({
      http: () => new Response('no', { status: 404 }),
      upgrade: () => 'hang',
    })
    try {
      const started = performance.now()
      await expect(
        discoverMoonraker({
          origin: `http://127.0.0.1:${hang.port}`,
          limits: { ...limits, connectTimeoutMs: 200 },
          signal: new AbortController().signal,
          client,
        }),
      ).rejects.toMatchObject({ reason: 'offline' })
      expect(performance.now() - started).toBeLessThan(4000)
    } finally {
      await hang.stop()
    }
  })

  test('unreachable origin rejects offline; invalid origin input throws', async () => {
    await expect(run({ origin: 'http://127.0.0.1:1' })).rejects.toMatchObject({
      reason: 'offline',
    })
    for (const origin of [
      'ftp://127.0.0.1',
      'http://u:p@127.0.0.1',
      'http://127.0.0.1/x?y',
    ])
      await expect(run({ origin })).rejects.toThrow()
    await expect(
      run({ origin: 'http://127.0.0.1:1' }, { webcamOrigin: 'javascript:1' }),
    ).rejects.toThrow()
  })
})
