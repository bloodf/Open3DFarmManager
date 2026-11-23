import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createBambuRuntimeSubscription,
  type BambuRuntimeEvent,
} from '../../packages/connector/src/bambu/runtime.ts'
import { parseBambuBinding } from '../../packages/connector/src/bambu/configuration.ts'

type RuntimePeer = Parameters<
  NonNullable<Parameters<typeof createBambuRuntimeSubscription>[0]['transport']>
>[0]

async function withBambuRuntime(
  run: (input: {
    peer: RuntimePeer
    report: (print: object) => void
    events: BambuRuntimeEvent[]
  }) => Promise<void> | void,
) {
  vi.useFakeTimers()
  const dir = mkdtempSync(join(tmpdir(), 'bambu-runtime-'))
  const credentialFile = join(dir, 'credential.json')
  writeFileSync(credentialFile, JSON.stringify({ accessCode: 'synthetic' }))
  chmodSync(credentialFile, 0o600)
  const events: BambuRuntimeEvent[] = []
  let peer: RuntimePeer | undefined
  let finish = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const sub = createBambuRuntimeSubscription({
    binding: parseBambuBinding({
      printerKey: 'test',
      serial: 'SYNTHETIC',
      host: '127.0.0.1',
      credentialFile,
      pinSha256: 'a'.repeat(64),
      allowedEndpoints: [{ host: '127.0.0.1' }],
    }),
    signal: new AbortController().signal,
    staleAfterMs: 100,
    onEvent: (event) => {
      events.push(event)
    },
    transport: (options) => {
      peer = options
      options.signal.addEventListener('abort', finish, { once: true })
      return {
        done,
        close: async () => {
          finish()
        },
      }
    },
  })
  try {
    expect(peer).toBeDefined()
    const connectedPeer = peer
    if (!connectedPeer) throw new Error('Expected the Bambu transport to start')
    const report = (print: object) =>
      connectedPeer.onReport(Buffer.from(JSON.stringify({ print })))
    await run({ peer: connectedPeer, report, events })
  } finally {
    sub.close()
    await sub.done
    rmSync(dir, { recursive: true })
    vi.useRealTimers()
  }
}

it('merges real decoded deltas, expires fields and isolates disconnect epochs', () =>
  withBambuRuntime(async ({ peer, report, events }) => {
    peer.onConnection('connected')
    report({ gcode_state: 'RUNNING' })
    expect(events.some((e) => e.kind === 'snapshot')).toBe(false)
    report({ mc_percent: 42 })
    expect(events.at(-1)).toMatchObject({
      kind: 'snapshot',
      printer: { state: 'printing', progress: 0.42 },
      source: { serial: 'SYNTHETIC', epoch: 1 },
    })
    peer.onConnection('disconnected')
    expect(events.at(-1)).toMatchObject({
      kind: 'unavailable',
      reason: 'disconnected',
    })
    peer.onConnection('connected')
    report({ mc_percent: 50 })
    expect(events.at(-1)?.kind).toBe('unavailable')
    report({ gcode_state: 'PAUSE' })
    expect(events.at(-1)).toMatchObject({
      kind: 'snapshot',
      source: { epoch: 2 },
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(events.at(-1)).toMatchObject({
      kind: 'unavailable',
      reason: 'stale',
    })
    report({ gcode_state: 'RUNNING', mc_percent: 10 })
    report({ gcode_state: 'UNKNOWN' })
    expect(events.at(-1)?.kind).toBe('unavailable')
  }))

const reportedAlarms = {
  print_error: 0x03008005,
  hms: [{ attr: 0x05000200, code: 0x00020001 }],
}

it('publishes a bounded alarm summary alongside a RUNNING observation', () =>
  withBambuRuntime(({ peer, report, events }) => {
    peer.onConnection('connected')
    report({ gcode_state: 'RUNNING', mc_percent: 42, ...reportedAlarms })
    expect(events.at(-1)).toMatchObject({
      kind: 'snapshot',
      printer: {
        state: 'printing',
        alarms: {
          printError: '0300-8005',
          hmsCount: 1,
          hmsCode: '0500-0200-0002-0001',
        },
      },
    })
  }))

it('clears observed alarms independently when RUNNING reports carry a clear', () =>
  withBambuRuntime(({ peer, report, events }) => {
    peer.onConnection('connected')
    report({ gcode_state: 'RUNNING', mc_percent: 42, ...reportedAlarms })
    report({ print_error: 0 })
    expect(events.at(-1)).toMatchObject({
      kind: 'snapshot',
      printer: {
        state: 'printing',
        alarms: {
          printError: null,
          hmsCount: 1,
          hmsCode: '0500-0200-0002-0001',
        },
      },
    })
    report({ hms: [] })
    expect(events.at(-1)).toMatchObject({
      kind: 'snapshot',
      printer: {
        state: 'printing',
        alarms: { printError: null, hmsCount: 0, hmsCode: null },
      },
    })
  }))

it('observes up to 64 HMS entries and keeps printing observable on an oversized report', () =>
  withBambuRuntime(({ peer, report, events }) => {
    peer.onConnection('connected')
    const hms = Array.from({ length: 64 }, (_, index) => ({
      attr: 0x05000200,
      code: 0x00020001 + index,
    }))
    report({ gcode_state: 'RUNNING', mc_percent: 42, hms })
    expect(events.at(-1)).toMatchObject({
      kind: 'snapshot',
      printer: {
        state: 'printing',
        alarms: { hmsCount: 64, hmsCode: '0500-0200-0002-0001' },
      },
    })
    report({
      mc_percent: 43,
      hms: [...hms, { attr: 0x05000200, code: 0x000200ff }],
    })
    expect(events.at(-1)).toMatchObject({
      kind: 'snapshot',
      printer: {
        state: 'printing',
        progress: 0.43,
        alarms: { hmsCount: null, hmsCode: null },
      },
    })
  }))
