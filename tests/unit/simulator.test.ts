import { expect, test } from 'vitest'
import { vi } from 'vitest'
import { simulatorUrl, probePrinter } from '@open3dfarmmanager/sim-tools'
import { Effect } from 'effect'
import { serveTestServer } from './serve.ts'

test.each([
  'https://localhost',
  'http://192.168.1.2',
  'http://example.com',
  'http://user:pass@localhost',
  'http://localhost/path',
  'http://localhost?x=1',
])('blocks non-isolated probe %s', (value) => {
  expect(() => simulatorUrl(value)).toThrow()
})
test('requires ready Klipper, not just a responding HTTP server', async () => {
  let state = 'startup'
  const server = await serveTestServer(() =>
    Response.json({
      result: { klippy_connected: true, klippy_state: state },
    }),
  )
  try {
    await expect(
      Effect.runPromise(probePrinter(server.url.origin)),
    ).rejects.toThrow()
    state = 'ready'
    expect(
      (await Effect.runPromise(probePrinter(server.url.origin))).klippy_state,
    ).toBe('ready')
  } finally {
    await server.stop()
  }
})
test('does not follow redirects out of the simulator boundary', async () => {
  const server = await serveTestServer(() =>
    Response.redirect('https://example.com'),
  )
  const nativeFetch = globalThis.fetch
  const policies: Array<RequestRedirect | undefined> = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    policies.push(init?.redirect)
    if (init?.redirect !== 'error')
      throw new Error(
        'Redirect policy did not block an off-fixture destination',
      )
    return nativeFetch(input, init)
  })
  try {
    await expect(
      Effect.runPromise(probePrinter(server.url.origin)),
    ).rejects.toThrow()
    expect(policies).toEqual(['error'])
  } finally {
    vi.unstubAllGlobals()
    await server.stop()
  }
})

test.each([
  { klippy_connected: true, klippy_state: 'shutdown' },
  { klippy_connected: true, klippy_state: 'error' },
  { klippy_connected: false, klippy_state: 'ready' },
  { klippy_connected: 'true', klippy_state: 'ready' },
  { klippy_state: 'ready' },
  { klippy_connected: true },
])(
  'rejects disconnected, failed or malformed readiness: %j',
  async (result) => {
    const server = await serveTestServer(() => Response.json({ result }))
    try {
      await expect(
        Effect.runPromise(probePrinter(server.url.origin)),
      ).rejects.toThrow()
    } finally {
      await server.stop()
    }
  },
)
