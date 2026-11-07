import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    terminate() {}
    ping() {}
  },
}))
import WebSocket from 'ws'
import { createSpoolmanProvider } from '../../packages/connector/src/runtime/spoolman-provider.ts'
const config = {
  origin: 'http://spoolman.local:8000',
  farmId: '00000000-0000-4000-8000-000000000001',
  serviceId: '00000000-0000-4000-8000-000000000002',
  limit: 200,
}
afterEach(() => vi.useRealTimers())
const event = Buffer.from(
  JSON.stringify({
    type: 'updated',
    resource: 'spool',
    date: '2026-11-07T00:00:00Z',
    payload: { id: 1 },
  }),
)
function response(id: number) {
  return new Response(
    JSON.stringify([{ id, filament: { id: 1 }, archived: false }]),
    {
      headers: { 'content-type': 'application/json' },
    },
  )
}
test('coalesces updates, rejects an invalidated traversal, refetches and closes owned resources', async () => {
  vi.useFakeTimers()
  const socket = new WebSocket('ws://unused')
  let resolve!: (value: Response) => void
  const first = new Promise<Response>((done) => {
    resolve = done
  })
  const request = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(first)
    .mockResolvedValue(response(2))
  const abort = new AbortController()
  const provider = createSpoolmanProvider({
    config,
    signal: abort.signal,
    transport: { fetch: request, socket: () => socket, now: () => Date.now() },
  })
  socket.emit('open')
  await vi.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 100; i++) socket.emit('message', event, false)
  resolve(response(1))
  await vi.advanceTimersByTimeAsync(0)
  expect(provider.snapshot().inventory).toBeNull()
  await vi.advanceTimersByTimeAsync(1000)
  expect(request).toHaveBeenCalledTimes(2)
  expect(provider.snapshot().inventory?.items.map((item) => item.id)).toEqual([
    2,
  ])
  expect(provider.snapshot().kind).toBe('observed')
  const options = request.mock.calls[0]![1]
  expect(options).toMatchObject({
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
  })
  socket.emit('close')
  expect(provider.snapshot().kind).toBe('stale')
  abort.abort()
  await provider.done
  expect(socket.listenerCount('message')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(request).toHaveBeenCalledTimes(2)
})
test('aborted startup makes no network transport and config rejects remote authority tricks', async () => {
  const abort = new AbortController()
  abort.abort()
  const socket = vi.fn()
  const provider = createSpoolmanProvider({
    config,
    signal: abort.signal,
    transport: { socket },
  })
  await provider.done
  expect(socket).not.toHaveBeenCalled()
  for (const origin of [
    'http://user:secret@host',
    'http://host/path',
    'http://host/?x=1',
  ]) {
    expect(() =>
      createSpoolmanProvider({
        config: { ...config, origin },
        signal: abort.signal,
      }),
    ).toThrow()
  }
})
