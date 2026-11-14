import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createBambuRuntimeSubscription, type BambuRuntimeEvent } from '../../packages/connector/src/bambu/runtime.ts'
import { parseBambuBinding } from '../../packages/connector/src/bambu/configuration.ts'

it('merges real decoded deltas, expires fields and isolates disconnect epochs', async () => {
  vi.useFakeTimers()
  const dir = mkdtempSync(join(tmpdir(), 'bambu-runtime-'))
  const credentialFile = join(dir, 'credential.json')
  writeFileSync(credentialFile, JSON.stringify({ accessCode: 'synthetic' }))
  chmodSync(credentialFile, 0o600)
  const events: BambuRuntimeEvent[] = []
  let peer: Parameters<NonNullable<Parameters<typeof createBambuRuntimeSubscription>[0]['transport']>>[0] | undefined
  let finish = () => {}
  const done = new Promise<void>(resolve => { finish = resolve })
  const sub = createBambuRuntimeSubscription({
    binding: parseBambuBinding({ printerKey: 'test', serial: 'SYNTHETIC', host: '127.0.0.1', credentialFile, pinSha256: 'a'.repeat(64), allowedEndpoints: [{ host: '127.0.0.1' }] }),
    signal: new AbortController().signal, staleAfterMs: 100,
    onEvent: event => { events.push(event) },
    transport: options => { peer = options; options.signal.addEventListener('abort', finish, { once: true }); return { done, close: async () => { finish() } } },
  })
  try {
    expect(peer).toBeDefined()
    const report = (print: object) => peer?.onReport(Buffer.from(JSON.stringify({ print })))
    peer?.onConnection('connected')
    report({ gcode_state: 'RUNNING' })
    expect(events.some(e => e.kind === 'snapshot')).toBe(false)
    report({ mc_percent: 42 })
    expect(events.at(-1)).toMatchObject({ kind: 'snapshot', printer: { state: 'printing', progress: .42 }, source: { serial: 'SYNTHETIC', epoch: 1 } })
    peer?.onConnection('disconnected')
    expect(events.at(-1)).toMatchObject({ kind: 'unavailable', reason: 'disconnected' })
    peer?.onConnection('connected')
    report({ mc_percent: 50 })
    expect(events.at(-1)?.kind).toBe('unavailable')
    report({ gcode_state: 'PAUSE' })
    expect(events.at(-1)).toMatchObject({ kind: 'snapshot', source: { epoch: 2 } })
    await vi.advanceTimersByTimeAsync(100)
    expect(events.at(-1)).toMatchObject({ kind: 'unavailable', reason: 'stale' })
    report({ gcode_state: 'RUNNING', mc_percent: 10 })
    report({ gcode_state: 'UNKNOWN' })
    expect(events.at(-1)?.kind).toBe('unavailable')
  } finally {
    sub.close(); await sub.done
    rmSync(dir, { recursive: true })
    vi.useRealTimers()
  }
})
