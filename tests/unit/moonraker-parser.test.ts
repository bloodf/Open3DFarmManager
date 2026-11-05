import { expect, test } from 'bun:test'
import fixture from '../fixtures/moonraker/printing.json'
import {
  parseMoonrakerSnapshot,
  parseMoonrakerServerInfo,
  MoonrakerReadError,
} from '../../packages/connector/src/moonraker/parse.ts'
const context = { printerKey: 'sim-1', observedAt: 1_800_000_000_000 }
const wire = JSON.stringify(fixture)
function snapshot(overrides: Record<string, unknown>) {
  return JSON.stringify({
    result: {
      ...fixture.result,
      status: { ...fixture.result.status, ...overrides },
    },
  })
}

test('synthetic complete snapshot projects only supported fields with the local observation clock', () => {
  expect(parseMoonrakerSnapshot(wire, context)).toEqual({
    sourceEventtime: 42.5,
    printer: { ...context, state: 'printing', progress: 0.25 },
  })
  expect(JSON.stringify(parseMoonrakerSnapshot(wire, context))).not.toContain(
    'filename',
  )
  expect(fixture.result.status.print_stats.state).toBe('printing')
})
test.each([
  ['standby', 'idle'],
  ['printing', 'printing'],
  ['paused', 'paused'],
  ['error', 'error'],
  ['complete', 'idle'],
  ['cancelled', 'idle'],
] as const)('maps print status %s to %s', (upstream, normalized) => {
  expect(
    parseMoonrakerSnapshot(
      snapshot({ print_stats: { state: upstream } }),
      context,
    ).printer.state,
  ).toBe(normalized)
})
test('Klippy availability takes precedence over a stale printing state', () => {
  for (const [upstream, normalized] of [
    ['startup', 'offline'],
    ['error', 'error'],
    ['shutdown', 'error'],
  ] as const)
    expect(
      parseMoonrakerSnapshot(
        snapshot({ webhooks: { state: upstream } }),
        context,
      ).printer.state,
    ).toBe(normalized)
})
test('missing, null and unknown object states do not fabricate an idle printer', () => {
  for (const replacement of [
    { webhooks: null },
    { print_stats: {} },
    { virtual_sdcard: null },
    { print_stats: { state: 'future-state' } },
    { webhooks: { state: 'future-state' } },
    { virtual_sdcard: { progress: '0.5' } },
  ])
    expect(() =>
      parseMoonrakerSnapshot(snapshot(replacement), context),
    ).toThrow(MoonrakerReadError)
  expect(() =>
    parseMoonrakerSnapshot('{"result":{"eventtime":1,"status":{}}}', context),
  ).toThrow('invalid-result')
})
test('progress and eventtime bounds reject rather than clamp invalid values', () => {
  for (const progress of [-0.1, 1.1, null, 'NaN'])
    expect(() =>
      parseMoonrakerSnapshot(
        snapshot({ virtual_sdcard: { progress } }),
        context,
      ),
    ).toThrow('invalid-result')
  for (const progress of [0, 1])
    expect(
      parseMoonrakerSnapshot(
        snapshot({ virtual_sdcard: { progress } }),
        context,
      ).printer.progress,
    ).toBe(progress)
  expect(() =>
    parseMoonrakerSnapshot(wire.replace('42.5', '1e309'), context),
  ).toThrow('invalid-frame')
  expect(() =>
    parseMoonrakerSnapshot(wire.replace('42.5', '-1'), context),
  ).toThrow('invalid-result')
})
test('HTTP framing rejects RPC, error/result mixtures and oversized multibyte data without echoing remote content', () => {
  for (const frame of [
    'null',
    '[]',
    '{}',
    '{',
    JSON.stringify({ jsonrpc: '2.0', id: 1, ...fixture }),
    JSON.stringify({ ...fixture, error: { message: 'REMOTE_PRIVATE_TEXT' } }),
  ]) {
    try {
      parseMoonrakerSnapshot(frame, context)
      throw new Error('Unexpected success')
    } catch (error) {
      expect(error).toBeInstanceOf(MoonrakerReadError)
      expect(String(error)).not.toContain('REMOTE_PRIVATE_TEXT')
    }
  }
  expect(() => parseMoonrakerSnapshot('é'.repeat(131073), context)).toThrow(
    'frame-too-large',
  )
  expect(() =>
    parseMoonrakerSnapshot(wire, { ...context, observedAt: -1 }),
  ).toThrow('invalid-context')
})
test('server readiness requires both a connection and ready state', () => {
  for (const state of [
    'startup',
    'shutdown',
    'error',
    'disconnected',
    'ready',
  ]) {
    for (const connected of [false, true]) {
      const info = parseMoonrakerServerInfo(
        JSON.stringify({
          result: {
            klippy_connected: connected,
            klippy_state: state,
            components: ['synthetic'],
          },
        }),
      )
      expect(info.ready).toBe(connected && state === 'ready')
    }
  }
  expect(() =>
    parseMoonrakerServerInfo('{"result":{"klippy_connected":true}}'),
  ).toThrow('invalid-result')
})
