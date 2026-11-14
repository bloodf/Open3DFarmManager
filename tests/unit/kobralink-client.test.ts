import { describe, expect, it, vi } from 'vitest'
import {
  createKobraLinkClient,
  type KobraLinkFetch,
} from '../../packages/connector/src/kobralink/client.ts'

const origin = 'http://127.0.0.1:7100'
const binding = { id: 'printer-1', deviceId: 'device-1' }
// Original synthetic fixture matching upstream 5a5e5d9 packages/shared/src/state.ts and printer.ts.
const printer = (live: unknown) => ({
  ...binding,
  name: 'Kobra X',
  ip: '192.168.1.20',
  username: 'secret-mqtt',
  settings: { powerOnUrl: 'secret-url' },
  live,
})
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
const live = () => ({
  connected: true,
  updatedAt: Date.now(),
  firmwareVersion: 'unknown',
  printState: 'paused',
  kobraState: 'pausing',
  cameraUrl: 'secret-camera',
})
async function ready(transport: KobraLinkFetch) {
  const client = createKobraLinkClient({
    origin,
    allowedOrigins: [origin],
    fetch: async (url, init) =>
      url.includes('/api/auth/')
        ? new Response('{}', {
            headers: {
              'set-cookie':
                'better-auth.session_token=secret; HttpOnly; Path=/',
            },
          })
        : transport(url, init),
  })
  await client.authenticate({
    ownership: 'fresh_owned',
    mode: 'signin',
    name: 'Connector',
    email: 'connector@example.test',
    password: 'synthetic-password',
  })
  return client
}
describe('bounded Connector management client', () => {
  it('requires a canonical allowlisted private origin', () => {
    for (const value of [
      'http://example.com',
      'http://127.0.0.1:7100/',
      'http://127.0.0.1:7100/path',
      'http://user:pass@127.0.0.1:7100',
    ])
      expect(() =>
        createKobraLinkClient({ origin: value, allowedOrigins: [value] }),
      ).toThrow('invalid')
  })
  it('sanitizes wire fields and does not confirm pausing', async () => {
    const client = await ready(async () => json(printer(live())))
    expect(await client.getPrinter(binding)).toEqual({
      ...binding,
      name: 'Kobra X',
      availability: 'available',
      printState: 'pausing',
      firmware: null,
      model: 'Kobra X',
      modelEvidence: 'user_declared_unverified',
    })
  })
  it.each([null, undefined, { ...live(), updatedAt: 1 }])(
    'treats absent or stale live as unavailable',
    async (value) => {
      const client = await ready(async () => json(printer(value)))
      expect((await client.getPrinter(binding)).availability).toBe(
        'unavailable',
      )
    },
  )
  it('preserves disconnection and unknown states', async () => {
    const client = await ready(async () =>
      json(printer({ ...live(), connected: false })),
    )
    expect(await client.getPrinter(binding)).toMatchObject({
      availability: 'disconnected',
      printState: 'unknown',
    })
    const other = await ready(async () =>
      json(
        printer({
          ...live(),
          printState: 'new-state',
          kobraState: 'new-state',
        }),
      ),
    )
    expect((await other.getPrinter(binding)).printState).toBe('unknown')
  })
  it('checks identity on detail and repeated list reads', async () => {
    let changed = false
    const client = await ready(async () =>
      json([
        { ...printer(live()), deviceId: changed ? 'other' : binding.deviceId },
      ]),
    )
    await client.listPrinters()
    changed = true
    await expect(client.listPrinters()).rejects.toMatchObject({
      code: 'identity_changed',
    })
    const other = await ready(async () =>
      json({ ...printer(live()), deviceId: 'other' }),
    )
    await expect(other.getPrinter(binding)).rejects.toMatchObject({
      code: 'identity_changed',
    })
  })
  it('rejects redirects without retry and redacts remote errors', async () => {
    const transport = vi.fn(
      async () =>
        new Response('secret-password-cookie', {
          status: 302,
          headers: { location: 'http://example.com' },
        }),
    )
    const client = await ready(transport)
    await expect(client.listPrinters()).rejects.toThrow('KobraLink: invalid')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0]?.length).toBeDefined()
  })
  it('bounds bytes and nesting', async () => {
    for (const value of [
      'x'.repeat(65537),
      '['.repeat(15) + '0' + ']'.repeat(15),
    ]) {
      const client = await ready(
        async () =>
          new Response(value, {
            headers: { 'content-type': 'application/json' },
          }),
      )
      await expect(client.listPrinters()).rejects.toMatchObject({
        code: 'invalid',
      })
    }
  })
  it('times out even when transport ignores abort', async () => {
    const client = createKobraLinkClient({
      origin,
      allowedOrigins: [origin],
      timeoutMs: 5,
      fetch: () => new Promise(() => {}),
    })
    await expect(client.setupStatus()).rejects.toMatchObject({
      code: 'timeout',
    })
  })
  it('times out a stalled response body', async () => {
    const client = createKobraLinkClient({
      origin,
      allowedOrigins: [origin],
      timeoutMs: 5,
      fetch: async () =>
        new Response(new ReadableStream(), {
          headers: { 'content-type': 'application/json' },
        }),
    })
    await expect(client.setupStatus()).rejects.toMatchObject({
      code: 'timeout',
    })
  })
  it('never retries a failed create', async () => {
    let writes = 0
    const client = await ready(async (_url, init) => {
      if (init.method === 'POST') {
        writes++
        throw new Error('private transport failure')
      }
      return json([])
    })
    await expect(
      client.createOrReconcile({
        ip: '192.168.1.20',
        name: 'Kobra X',
        deviceId: binding.deviceId,
      }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(writes).toBe(1)
  })
  it('never takes over an initialized bridge', async () => {
    const fetch = vi.fn(async () => json({ needsSetup: false }))
    const client = createKobraLinkClient({
      origin,
      allowedOrigins: [origin],
      fetch,
    })
    await expect(
      client.authenticate({
        ownership: 'fresh_owned',
        mode: 'signup',
        name: 'Connector',
        email: 'c@example.test',
        password: 'synthetic-password',
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('keeps auth errors opaque', async () => {
    const client = createKobraLinkClient({
      origin,
      allowedOrigins: [origin],
      fetch: async () => {
        throw new Error('secret-password-cookie')
      },
    })
    await expect(
      client.authenticate({
        ownership: 'fresh_owned',
        mode: 'signin',
        name: 'Connector',
        email: 'c@example.test',
        password: 'synthetic-password',
      }),
    ).rejects.toThrow('KobraLink: unavailable')
  })
  it('reconciles partial create without resending the write', async () => {
    let created = false
    let writes = 0
    const client = await ready(async (_url, init) => {
      if (init.method === 'POST') {
        writes++
        created = true
        return new Response('private failure', { status: 503 })
      }
      return json(created ? [printer(null)] : [])
    })
    const input = {
      ip: '192.168.1.20',
      name: 'Kobra X',
      deviceId: binding.deviceId,
    }
    expect((await client.createOrReconcile(input)).id).toBe(binding.id)
    await client.createOrReconcile(input)
    expect(writes).toBe(1)
  })
  it('reports reconnect acceptance without command confirmation', async () => {
    const client = await ready(async (_url, init) =>
      init.method === 'POST'
        ? new Response(null, { status: 204 })
        : json(
            printer({
              ...live(),
              connected: false,
              connectionError: { code: 'lost' },
            }),
          ),
    )
    expect(await client.reconnect(binding)).toEqual({
      accepted: true,
      confirmed: false,
    })
  })
  it.each(['manual', 'reconnecting'])('does not reconnect %s', async (code) => {
    const client = await ready(async () =>
      json(printer({ ...live(), connected: false, connectionError: { code } })),
    )
    await expect(client.reconnect(binding)).rejects.toMatchObject({
      code: 'unavailable',
    })
  })
  it('discovers sanitized identities without secrets', async () => {
    const client = await ready(async () =>
      json([{ ...printer(null), model: 'Kobra X', ip: '192.168.1.20' }]),
    )
    const [identity] = await client.listPrinterIdentities()
    expect(identity).toEqual({
      ...binding,
      ip: '192.168.1.20',
      model: 'Kobra X',
      firmware: null,
    })
    expect(JSON.stringify(identity)).not.toContain('secret')
  })
  it('creates an unknown printer once with ip and name only', async () => {
    const bodies: string[] = []
    const client = await ready(async (_url, init) => {
      bodies.push(String(init.body))
      return init.method === 'POST'
        ? json({ ...printer(null), ip: '192.168.1.20', model: 'Kobra X' })
        : json([])
    })
    expect(
      (await client.createPrinter({ ip: '192.168.1.20', name: 'Kobra X' }))
        .deviceId,
    ).toBe(binding.deviceId)
    expect(bodies).toEqual(['{"ip":"192.168.1.20","name":"Kobra X"}'])
    await expect(
      client.createPrinter({
        ip: '192.168.1.20',
        name: 'Kobra X',
        httpPort: 18910,
      } as never),
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      client.createPrinter({ ip: '8.8.8.8', name: 'Kobra X' }),
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(bodies).toHaveLength(1)
  })
  it('never resends a create whose response was lost', async () => {
    let writes = 0
    const client = await ready(async (_url, init) => {
      if (init.method === 'POST') writes++
      throw new Error('lost')
    })
    await expect(
      client.createPrinter({ ip: '192.168.1.20', name: 'Kobra X' }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(writes).toBe(1)
  })
  it('deletes an owned printer only after rechecking its identity', async () => {
    const methods: string[] = []
    const client = await ready(async (_url, init) => {
      methods.push(String(init.method))
      return init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json(printer(null))
    })
    expect(await client.deleteOwnedPrinter(binding)).toEqual({ deleted: true })
    await expect(
      client.deleteOwnedPrinter({ ...binding, deviceId: 'other-device' }),
    ).rejects.toMatchObject({ code: 'identity_changed' })
    expect(methods).toEqual(['GET', 'DELETE', 'GET'])
  })
})
