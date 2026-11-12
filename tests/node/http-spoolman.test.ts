import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { createLoopbackSpoolmanReader } from '../../packages/connector/src/spoolman/http-read.ts'
const context = {
  farmId: '00000000-0000-4000-8000-000000000001',
  serviceId: '00000000-0000-4000-8000-000000000002',
  limit: 2,
}
const spool = (id: number) => ({ id, filament: { id: 1 }, archived: false })
async function server(handler: RequestListener) {
  const instance = createServer(handler)
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`,
    close: async () => {
      instance.closeAllConnections()
      await new Promise<void>((resolve) => instance.close(() => resolve()))
    },
  }
}
const reader = (origin: string, timeoutMs = 2000) =>
  createLoopbackSpoolmanReader({ origin, context, timeoutMs })

test('reads complete inventory with fixed GET parameters and frozen configuration', async () => {
  const offsets: string[] = []
  const fixture = await server((req, res) => {
    assert.equal(req.method, 'GET')
    const url = new URL(req.url!, 'http://127.0.0.1')
    assert.equal(url.pathname, '/api/v1/spool')
    assert.equal(url.searchParams.get('sort'), 'id:asc')
    assert.equal(url.searchParams.get('allow_archived'), 'true')
    assert.equal(url.searchParams.get('limit'), '2')
    offsets.push(url.searchParams.get('offset')!)
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify(
        offsets.length === 1
          ? [spool(1), { ...spool(2), next: 'http://example.invalid' }]
          : [],
      ),
    )
  })
  try {
    const options = {
      origin: fixture.origin,
      context: { ...context },
      timeoutMs: 2000,
    }
    const read = createLoopbackSpoolmanReader(options)
    options.origin = 'http://example.invalid'
    options.context.limit = 200
    assert.deepEqual(
      (await read()).items.map((item) => item.id),
      [1, 2],
    )
    assert.deepEqual(offsets, ['0', '2'])
  } finally {
    await fixture.close()
  }
})

test('rejects noncanonical, nonloopback and credential-bearing configuration', () => {
  for (const origin of [
    'http://localhost',
    'http://127.1',
    'http://2130706433',
    'http://127.0.0.1/path',
    'http://user@127.0.0.1',
    'http://127.0.0.1?x',
    'http://192.168.1.1',
    ' http://127.0.0.1',
  ])
    assert.throws(() => reader(origin), /Invalid local Spoolman configuration/)
  for (const timeoutMs of [0, Infinity, 60001])
    assert.throws(() => reader('http://127.0.0.1', timeoutMs))
})

test('duplicate later page rejects entire result and stops requests', async () => {
  let requests = 0
  const fixture = await server((_req, res) => {
    requests++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify([spool(1), spool(2)]))
  })
  try {
    await assert.rejects(
      reader(fixture.origin)(),
      /^Error: Local Spoolman read failed$/,
    )
    assert.equal(requests, 2)
  } finally {
    await fixture.close()
  }
})

test('does not follow redirect or reveal upstream error details', async () => {
  let hits = 0
  const target = await server((_req, res) => {
    hits++
    res.end('secret')
  })
  const fixture = await server((_req, res) => {
    res.writeHead(302, { location: target.origin })
    res.end('secret')
  })
  try {
    await assert.rejects(
      reader(fixture.origin)(),
      /^Error: Local Spoolman read failed$/,
    )
    assert.equal(hits, 0)
  } finally {
    await fixture.close()
    await target.close()
  }
})

test('rejects malformed, ambiguous, oversized and wrong-type responses', async () => {
  const cases = [
    { status: 500, type: 'application/json', body: Buffer.from('secret') },
    { status: 200, type: 'text/html', body: Buffer.from('[]') },
    { status: 200, type: 'application/json', body: Buffer.from([0xff]) },
    {
      status: 200,
      type: 'application/json',
      body: Buffer.from('[{"id":1,"id":2}]'),
    },
    {
      status: 200,
      type: 'application/json',
      body: gzipSync(Buffer.from(' '.repeat(256 * 1024 + 1))),
      encoding: 'gzip',
    },
  ]
  for (const value of cases) {
    const fixture = await server((_req, res) => {
      res.statusCode = value.status
      res.setHeader('content-type', value.type)
      if (value.encoding) res.setHeader('content-encoding', value.encoding)
      res.end(value.body)
    })
    try {
      await assert.rejects(
        reader(fixture.origin)(),
        /^Error: Local Spoolman read failed$/,
      )
    } finally {
      await fixture.close()
    }
  }
})

test(
  'deadline spans pagination and hanging response body',
  { timeout: 5000 },
  async (t) => {
    // The 150 ms deadline elapses only on the virtual clock, after the second
    // page started its hanging body, whatever the host load.
    let now = 0
    t.mock.method(performance, 'now', () => now)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let requests = 0
    const fixture = await server((_req, res) => {
      requests++
      res.setHeader('content-type', 'application/json')
      if (requests === 1) res.end(JSON.stringify([spool(1), spool(2)]))
      else {
        res.write('[')
        setImmediate(() => {
          now += 150
          t.mock.timers.tick(150)
        })
      }
    })
    try {
      const started = Date.now()
      await assert.rejects(
        reader(fixture.origin, 150)(),
        /Local Spoolman read failed/,
      )
      assert.equal(requests, 2)
      assert.ok(Date.now() - started < 2000)
    } finally {
      await fixture.close()
    }
  },
)

test(
  'cancellation aborts headers and pre-aborted signals send nothing',
  { timeout: 5000 },
  async () => {
    let requests = 0
    const controller = new AbortController()
    const fixture = await server(() => {
      requests++
      controller.abort('secret')
    })
    try {
      await assert.rejects(
        reader(fixture.origin)(AbortSignal.abort('secret')),
        /Local Spoolman read failed/,
      )
      assert.equal(requests, 0)
      await assert.rejects(
        reader(fixture.origin)(controller.signal),
        /^Error: Local Spoolman read failed$/,
      )
      assert.equal(requests, 1)
    } finally {
      await fixture.close()
    }
  },
)

test(
  'one deadline covers multiple individually fast pages',
  { timeout: 5000 },
  async (t) => {
    // Each page takes 200 virtual ms against one 350 ms deadline. The clock
    // only moves inside the server, so CPU contention cannot change the result.
    let now = 0
    t.mock.method(performance, 'now', () => now)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let requests = 0
    const fixture = await server((_req, res) => {
      const current = ++requests
      now += 200
      t.mock.timers.tick(200)
      if (current !== 1) return
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify([spool(1), spool(2)]))
    })
    try {
      await assert.rejects(
        reader(fixture.origin, 350)(),
        /Local Spoolman read failed/,
      )
      assert.equal(requests, 2)
    } finally {
      await fixture.close()
    }
  },
)
