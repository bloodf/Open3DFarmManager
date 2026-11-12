import { describe, test, expect } from 'vitest'
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

  test('webcams: same-origin urls only, malformed dropped, count capped', () => {
    const cams = parseWebcamsResult(webcamList, origin)
    expect(cams).toHaveLength(2)
    expect(cams[0]).toMatchObject({
      name: 'u1',
      snapshotUrl: 'http://127.0.0.1:7125/webcam/?action=snapshot',
      rotation: 90,
      targetFps: 15,
      flipHorizontal: true,
    })
    expect(cams[1]).toMatchObject({
      name: 'foreign',
      snapshotUrl: null,
      streamUrl: null,
    })
    const many = {
      webcams: Array.from({ length: 50 }, (_, i) => ({ name: `c${i}` })),
    }
    expect(parseWebcamsResult(many, origin)).toHaveLength(MAX_WEBCAMS)
    expect(() => parseWebcamsResult({ webcams: 'x' }, origin)).toThrow()
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
async function serve(replies: Record<string, unknown | 'error' | 'junk'>) {
  const methods: string[] = []
  const server = await serveWsTestServer({
    http: () => new Response('no', { status: 404 }),
    upgrade: (request) => new URL(request.url).pathname === '/websocket',
    onMessage(socket, message) {
      const { id, method } = JSON.parse(message) as {
        id: number
        method: string
      }
      methods.push(method)
      const reply = replies[method]
      if (reply === 'junk') return socket.send('{not json')
      socket.send(
        JSON.stringify(
          reply === 'error'
            ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } }
            : { jsonrpc: '2.0', id, result: reply },
        ),
      )
    },
  })
  return { server, methods, origin: `http://127.0.0.1:${server.port}` }
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

describe('discoverMoonraker', () => {
  test('runs the read-only handshake in order and normalizes', async () => {
    const s = await serve(base)
    try {
      const out = await discoverMoonraker({
        origin: s.origin,
        limits,
        signal: AbortSignal.timeout(5000),
        client,
      })
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
      expect(out.webcams[0]!.snapshotUrl).toBe(
        `${s.origin}/webcam/?action=snapshot`,
      )
    } finally {
      await s.server.stop()
    }
  })

  test('missing webcam component is non-fatal', async () => {
    const s = await serve({ ...base, 'server.webcams.list': 'error' })
    try {
      const out = await discoverMoonraker({
        origin: s.origin,
        limits,
        signal: AbortSignal.timeout(5000),
        client,
      })
      expect(out.webcams).toEqual([])
    } finally {
      await s.server.stop()
    }
  })

  test.each([
    ['identify error', { ...base, 'server.connection.identify': 'error' }],
    [
      'malformed server.info',
      { ...base, 'server.info': { klippy_state: 'ready' } },
    ],
    ['junk frame', { ...base, 'printer.objects.list': 'junk' }],
  ])('%s rejects invalid-response', async (_name, replies) => {
    const s = await serve(replies as never)
    try {
      await expect(
        discoverMoonraker({
          origin: s.origin,
          limits,
          signal: AbortSignal.timeout(5000),
          client,
        }),
      ).rejects.toMatchObject({ reason: 'invalid-response' })
    } finally {
      await s.server.stop()
    }
  })

  test('unanswered request rejects stale; unreachable rejects offline', async () => {
    const hang = await serveWsTestServer({
      http: () => new Response('no', { status: 404 }),
      upgrade: () => true,
    })
    try {
      await expect(
        discoverMoonraker({
          origin: `http://127.0.0.1:${hang.port}`,
          limits,
          signal: AbortSignal.timeout(5000),
          client,
        }),
      ).rejects.toMatchObject({ reason: 'stale' })
    } finally {
      await hang.stop()
    }
    await expect(
      discoverMoonraker({
        origin: 'http://127.0.0.1:1',
        limits,
        signal: AbortSignal.timeout(5000),
        client,
      }),
    ).rejects.toMatchObject({ reason: 'offline' })
  })
})
