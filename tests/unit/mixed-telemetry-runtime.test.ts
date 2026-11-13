import { test, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLocalCollectorConfig } from '../../packages/connector/src/config/local.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'

// Replace only the Moonraker transport; subscription parsing and collection stay real.
vi.mock(
  '../../packages/connector/src/moonraker/client.ts',
  async (original) => {
    const actual =
      await original<
        typeof import('../../packages/connector/src/moonraker/client.ts')
      >()
    return {
      ...actual,
      readMoonrakerReady: vi.fn(async () => {}),
      openMoonrakerClient: vi.fn((input) => {
        expect(input.origin).toBe('http://127.0.0.1:7125')
        expect(input).not.toHaveProperty('credentialFile')
        const result = {
          eventtime: 123,
          status: {
            webhooks: { state: 'ready' },
            print_stats: { state: 'printing' },
            virtual_sdcard: { progress: 0.25 },
          },
        }
        let resolve!: (reason: string) => void
        const closed = new Promise<string>((done) => {
          resolve = done
        })
        const timer = setInterval(
          () =>
            input.onComplete?.({
              result: {
                ...result,
                eventtime: ++result.eventtime,
                status: {
                  ...result.status,
                  virtual_sdcard: { progress: 0.25 + result.eventtime / 10000 },
                },
              },
            }),
          500,
        )
        const close = () => {
          clearInterval(timer)
          resolve('offline')
        }
        input.signal.addEventListener('abort', close, { once: true })
        queueMicrotask(() => input.onComplete?.({ result }))
        return { snapshot: Promise.resolve(result), closed, close }
      }),
    }
  },
)

for (const failure of [
  'auth',
  'lost',
  'unknown',
  'stale',
  'disconnected',
] as const) {
  test(`mixed collection isolates ${failure} and recovers without stopping Moonraker`, async () => {
    await import('../../packages/connector/src/moonraker/subscription.ts')
    vi.useFakeTimers({ now: 1700000000000 })
    const dir = mkdtempSync(join(tmpdir(), 'mixed-telemetry-'))
    const controller = new AbortController()
    const binding = {
      backend: 'kobralink',
      version: 2,
      bridgeInstance: 'bridge',
      origin: 'http://127.0.0.1:8080',
      deviceId: 'kobra-x-device',
      id: 'kobra-x',
      printerKey: 'kobra',
      revision: 1,
      credentialFile: join(dir, 'credential.json'),
    }
    const { backend: _backend, credentialFile: _file, ...identity } = binding
    writeFileSync(
      binding.credentialFile,
      JSON.stringify({
        ...identity,
        version: 1,
        name: 'test',
        email: 'test@example.test',
        password: 'synthetic-password',
      }),
      { mode: 0o600 },
    )
    const config = parseLocalCollectorConfig({
      version: 2,
      allowedOrigins: ['http://127.0.0.1:7125'],
      printers: [{ printerKey: 'moon', origin: 'http://127.0.0.1:7125' }],
      kobralink: { allowedOrigins: [binding.origin], printers: [binding] },
    })
    const queue = new TelemetryQueue(join(dir, 'queue'), Date.now())
    let failing = true
    let auth = 0
    const unavailable: string[] = []
    const run = collectIntoQueue({
      config,
      queue,
      signal: controller.signal,
      onDiagnostic() {},
      onRawObservation(value) {
        expect(value.printer.printerKey).toBe(value.printerKey)
        if (value.printerKey === 'kobra') {
          expect(value.printer.observedAt).toBe(Date.now() - 100)
          expect(value.printer.progress).toBe(0.75)
        } else {
          expect(value.printerKey).toBe('moon')
          expect(value.printer.observedAt).toBe(Date.now())
        }
      },
      onRawUnavailable(event) {
        unavailable.push(event.printerKey)
      },
      kobraFetch: async (url, init) => {
        expect(new URL(url).origin).toBe(binding.origin)
        if (url.includes('/api/auth/')) {
          auth++
          expect(String(init.body)).toContain('synthetic-password')
          return new Response(null, {
            status: failing && failure === 'auth' ? 401 : 200,
            headers: { 'set-cookie': 'better-auth.session_token=kobra-only' },
          })
        }
        expect(url).toContain(binding.id)
        if (failing && failure === 'lost')
          throw Error('synthetic lost connection')
        return Response.json({
          id: binding.id,
          deviceId: binding.deviceId,
          name: 'Kobra X',
          live: {
            connected: !(failing && failure === 'disconnected'),
            updatedAt:
              Date.now() - (failing && failure === 'stale' ? 20000 : 100),
            printState:
              failing && failure === 'unknown' ? 'unknown' : 'printing',
            progress: 0.75,
          },
        })
      },
    })
    try {
      await vi.advanceTimersByTimeAsync(2500)
      const states = () =>
        queue
          .batch(Date.now())
          .records.flatMap((r) => (r.kind === 'printer-state' ? [r.state] : []))
      expect(states().length).toBeGreaterThan(0)
      expect(
        states().every(
          (s) =>
            s.printerKey === 'moon' &&
            s.progress >= 0.25 &&
            s.progress < 0.3 &&
            s.state === 'printing',
        ),
      ).toBe(true)
      expect(unavailable).toContain('kobra')
      const moonBefore = states().length
      failing = false
      await vi.advanceTimersByTimeAsync(4500)
      expect(
        states().filter((s) => s.printerKey === 'moon').length,
      ).toBeGreaterThan(moonBefore)
      expect(states().filter((s) => s.printerKey === 'kobra')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            progress: 0.75,
            state: 'printing',
            observedAt: expect.any(Number),
          }),
        ]),
      )
      if (failure === 'auth' || failure === 'lost')
        expect(auth).toBeGreaterThan(1)
      controller.abort()
      await run
      const depth = queue.depth
      await vi.advanceTimersByTimeAsync(10000)
      expect(queue.depth).toBe(depth)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      controller.abort()
      await run
      queue.close()
      rmSync(dir, { recursive: true })
      vi.useRealTimers()
    }
  })
}
