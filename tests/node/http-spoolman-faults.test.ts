import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import { createLoopbackSpoolmanReader } from '../../packages/connector/src/spoolman/http-read.ts'

const context = {
  farmId: '00000000-0000-4000-8000-000000000001',
  serviceId: '00000000-0000-4000-8000-000000000002',
  limit: 2,
}
const spool = (id: number, archived = false) => ({
  id,
  filament: { id: 1 },
  archived,
})
async function server(handler: RequestListener) {
  const instance = createServer(handler)
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      instance.closeAllConnections()
      await new Promise<void>((resolve) => instance.close(() => resolve()))
    },
  }
}
const reader = (origin: string) =>
  createLoopbackSpoolmanReader({ origin, context, timeoutMs: 2000 })

test('rejects descending IDs within and across pages without retrying', async () => {
  for (const pages of [
    [[spool(2), spool(1)]],
    [[spool(2), spool(3)], [spool(1)]],
  ]) {
    const requests: string[] = []
    const fixture = await server((req, res) => {
      requests.push(`${req.method} ${req.url}`)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(pages[requests.length - 1] ?? []))
    })
    try {
      await assert.rejects(
        reader(fixture.origin)(),
        /^Error: Local Spoolman read failed$/,
      )
      assert.equal(requests.length, pages.length)
      assert.ok(
        requests.every((request) => request.startsWith('GET /api/v1/spool?')),
      )
    } finally {
      await fixture.close()
    }
  }
})

test('recovers after a malformed later page and includes archived spools', async () => {
  const requests: string[] = []
  const fixture = await server((req, res) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1')
    requests.push(
      `${req.method} ${url.searchParams.get('offset')} ${url.searchParams.get('allow_archived')}`,
    )
    res.setHeader('content-type', 'application/json')
    if (requests.length === 2) res.end('{"secret":')
    else if (url.searchParams.get('offset') === '0')
      res.end(JSON.stringify([spool(1), spool(2, true)]))
    else res.end(JSON.stringify([spool(3, true)]))
  })
  try {
    const read = reader(fixture.origin)
    await assert.rejects(read(), /^Error: Local Spoolman read failed$/)
    assert.deepEqual(requests, ['GET 0 true', 'GET 2 true'])
    const result = await read()
    assert.deepEqual(
      result.items.map(({ id, archived }) => [id, archived]),
      [
        [1, false],
        [2, true],
        [3, true],
      ],
    )
    assert.deepEqual(requests, [
      'GET 0 true',
      'GET 2 true',
      'GET 0 true',
      'GET 2 true',
    ])
  } finally {
    await fixture.close()
  }
})

test('rejects an oversized chunked body without retrying', async () => {
  let requests = 0
  const fixture = await server((_req, res) => {
    requests++
    res.setHeader('content-type', 'application/json')
    res.write(' '.repeat(128 * 1024))
    res.end(' '.repeat(128 * 1024 + 1))
  })
  try {
    await assert.rejects(
      reader(fixture.origin)(),
      /^Error: Local Spoolman read failed$/,
    )
    assert.equal(requests, 1)
  } finally {
    await fixture.close()
  }
})

test(
  'caller cancellation during a body permits a fresh read',
  { timeout: 5000 },
  async () => {
    const controller = new AbortController()
    let requests = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const fixture = await server((_req, res) => {
      requests++
      res.setHeader('content-type', 'application/json')
      if (requests === 1) {
        res.write('[')
        timer = setTimeout(() => controller.abort('private reason'), 100)
      } else res.end(JSON.stringify([spool(4)]))
    })
    try {
      const read = reader(fixture.origin)
      await assert.rejects(
        read(controller.signal),
        /^Error: Local Spoolman read failed$/,
      )
      assert.equal(requests, 1)
      assert.deepEqual(
        (await read()).items.map((item) => item.id),
        [4],
      )
      assert.equal(requests, 2)
    } finally {
      clearTimeout(timer)
      await fixture.close()
    }
  },
)
