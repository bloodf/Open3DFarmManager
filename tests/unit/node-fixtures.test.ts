import { expect, test } from 'vitest'
import { serveTestServer } from './serve.ts'
import { serveWsTestServer } from './ws-serve.ts'
import { browserBundle } from '../helpers/browser-bundle.ts'

test('HTTP fixture is listening before it returns and forwards request bodies', async () => {
  const server = await serveTestServer(async (request) =>
    Response.json({ method: request.method, body: await request.text() }),
  )
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      body: 'fixture',
    })
    expect(await response.json()).toEqual({ method: 'POST', body: 'fixture' })
  } finally {
    await server.stop()
  }
})

test('WebSocket fixture HTTP listener is ready before it returns', async () => {
  const server = await serveWsTestServer({ http: () => new Response('ready') })
  try {
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe(
      'ready',
    )
  } finally {
    await server.stop()
  }
})

test('browser bundle rejects an already aborted request without starting a child', async () => {
  const controller = new AbortController()
  const reason = Error('fixture cancellation')
  controller.abort(reason)
  expect(() => browserBundle('unused.ts', controller.signal)).toThrow(reason)
})

test('browser bundle rejects a missing entry', async () => {
  await expect(
    browserBundle(
      new URL('./missing-bundle-entry.ts', import.meta.url).pathname,
    ),
  ).rejects.toThrow()
}, 15000)
