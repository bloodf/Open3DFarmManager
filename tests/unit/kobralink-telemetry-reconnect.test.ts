import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createKobraLinkRuntimeSubscription,
  KobraLinkRuntimeBinding,
} from '../../packages/connector/src/kobralink/runtime.ts'

afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
  })
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-reconnect-'))
  const binding = KobraLinkRuntimeBinding.parse({
    backend: 'kobralink',
    version: 2,
    bridgeInstance: 'owned',
    origin: 'http://127.0.0.1:8080',
    deviceId: 'device',
    id: 'printer',
    printerKey: 'kobra',
    revision: 1,
    credentialFile: join(dir, 'secret.json'),
  })
  writeFileSync(
    binding.credentialFile,
    JSON.stringify({
      ...binding,
      version: 1,
      backend: undefined,
      credentialFile: undefined,
      name: 'machine',
      email: 'machine@example.test',
      password: 'synthetic-only',
    }),
    { mode: 0o600 },
  )
  let reason: string | undefined = 'lost'
  let connected = false
  let stale = false
  let rebind = false
  let authError = false
  let hang = false
  let active = 0
  let maximum = 0
  const requests: { path: string; method: string; at: number }[] = []
  const statuses: string[] = []
  const sub = createKobraLinkRuntimeSubscription({
    binding,
    allowedOrigins: [binding.origin],
    signal: new AbortController().signal,
    onStatus: (s) => statuses.push(s.availability),
    onUnavailable() {},
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      requests.push({ path, method: init.method!, at: performance.now() })
      active++
      maximum = Math.max(maximum, active)
      try {
        if (path === '/api/auth/sign-in/email')
          return new Response(null, {
            headers: { 'set-cookie': 'better-auth.session_token=synthetic' },
          })
        if (authError) return new Response(null, { status: 401 })
        if (path.endsWith('/reconnect')) {
          if (hang)
            await new Promise<void>((resolve) =>
              init.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            )
          return new Response(null, { status: 204 })
        }
        const sameTimeReads = requests.filter(
          (r) => r.at === performance.now() && r.method === 'GET',
        ).length
        return Response.json({
          id: 'printer',
          deviceId: rebind && sameTimeReads > 1 ? 'other' : 'device',
          name: 'Kobra',
          live: {
            connected,
            updatedAt: Date.now() - (stale ? 20000 : 0),
            ...(reason ? { connectionError: { code: reason } } : {}),
          },
        })
      } finally {
        active--
      }
    },
  })
  return {
    requests,
    statuses,
    posts: () => requests.filter((r) => r.path.endsWith('/reconnect')),
    set: (value: {
      reason?: string | undefined
      connected?: boolean
      stale?: boolean
      rebind?: boolean
      authError?: boolean
      hang?: boolean
    }) => {
      reason = value.reason
      connected = value.connected ?? false
      stale = value.stale ?? false
      rebind = value.rebind ?? false
      authError = value.authError ?? false
      hang = value.hang ?? false
    },
    maximum: () => maximum,
    async close() {
      sub.close()
      await sub.done
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('long outage retries indefinitely at bounded cadence; only fresh online resets', async () => {
  const f = fixture()
  try {
    await vi.advanceTimersByTimeAsync(1050000)
    expect(f.posts().map((r) => r.at)).toEqual([
      30000, 90000, 210000, 450000, 750000, 1050000,
    ])
    expect(new Set(f.statuses)).toEqual(new Set(['disconnected']))
    f.set({ connected: true, stale: true })
    await vi.advanceTimersByTimeAsync(20000)
    f.set({ reason: 'unreachable_ip' })
    await vi.advanceTimersByTimeAsync(280000)
    expect(f.posts().at(-1)?.at).toBe(1350000)
    f.set({ connected: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.statuses.at(-1)).toBe('available')
    f.set({ reason: 'unreachable' })
    await vi.advanceTimersByTimeAsync(31000)
    expect(f.posts().at(-1)?.at).toBe(1382000)
    expect(f.maximum()).toBe(1)
    expect(
      f.requests.every(
        (r) =>
          (r.path === '/api/auth/sign-in/email' && r.method === 'POST') ||
          (r.path === '/api/v1/printers/printer' && r.method === 'GET') ||
          (r.path === '/api/v1/printers/printer/reconnect' &&
            r.method === 'POST'),
      ),
    ).toBe(true)
  } finally {
    await f.close()
  }
})

test.each([
  'manual',
  'reconnecting',
  'error-auth',
  'unknown',
  undefined,
  'healthy',
  'auth',
])('denies %s and aborts waiting', async (mode) => {
  const f = fixture()
  f.set({
    reason: mode,
    connected: mode === 'healthy',
    authError: mode === 'auth',
  })
  try {
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.posts()).toHaveLength(0)
  } finally {
    await f.close()
  }
  const count = f.requests.length
  await vi.advanceTimersByTimeAsync(600000)
  expect(f.requests).toHaveLength(count)
})

test('identity change during guard denies POST', async () => {
  const f = fixture()
  f.set({ reason: 'lost', rebind: true })
  try {
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.posts()).toHaveLength(0)
  } finally {
    await f.close()
  }
})

test('abort inflight reconnect prevents later requests and overlap', async () => {
  const f = fixture()
  f.set({ reason: 'lost', hang: true })
  await vi.advanceTimersByTimeAsync(31000)
  expect(f.posts()).toHaveLength(1)
  await f.close()
  const count = f.requests.length
  await vi.advanceTimersByTimeAsync(600000)
  expect(f.requests).toHaveLength(count)
  expect(f.maximum()).toBe(1)
})
