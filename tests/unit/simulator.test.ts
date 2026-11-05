import { expect, test } from 'bun:test'
import { simulatorUrl, probePrinter } from '@open3dfarmmanager/sim-tools'
import { Effect } from 'effect'

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
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      Response.json({
        result: { klippy_connected: true, klippy_state: state },
      }),
  })
  try {
    await expect(
      Effect.runPromise(probePrinter(server.url.origin)),
    ).rejects.toThrow()
    state = 'ready'
    expect(
      (await Effect.runPromise(probePrinter(server.url.origin))).klippy_state,
    ).toBe('ready')
  } finally {
    await server.stop(true)
  }
})
test('does not follow redirects out of the simulator boundary', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.redirect('https://example.com'),
  })
  try {
    await expect(
      Effect.runPromise(probePrinter(server.url.origin)),
    ).rejects.toThrow()
  } finally {
    await server.stop(true)
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
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ result }),
    })
    try {
      await expect(
        Effect.runPromise(probePrinter(server.url.origin)),
      ).rejects.toThrow()
    } finally {
      await server.stop(true)
    }
  },
)
