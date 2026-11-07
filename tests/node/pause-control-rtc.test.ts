import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parsePauseFixtureResponse,
  assertPauseFixtureClosed,
} from '../helpers/pause-control-rtc.ts'

// Explicit opt-in: synthetic trusted binding and issuer, actual RTC only.
// No current SQL/WSS, capability enforcement, command or driver claim.
const scenarios = [
  'valid',
  'wrong-assignment',
  'wrong-proof',
  'deadline',
  'oversize',
] as const
const selected = process.env.PAUSE_CONTROL_RTC_CASE
if (selected && !scenarios.some((value) => value === selected))
  throw Error('Unknown control RTC fixture case')
test(
  'isolated real pause-control RTC transport (synthetic authority)',
  {
    skip: process.env.PAUSE_CONTROL_RTC !== 'yes',
    timeout: selected ? 75000 : 375000,
    concurrency: false,
  },
  async () => {
    assert.equal(process.version, 'v24.20.0', 'Pinned Node24 runtime required')
    const { runPauseControlRtc } =
      await import('../helpers/pause-control-rtc.ts')
    // A rejected case stops this sequence; never automatically retry or continue.
    for (const scenario of scenarios) {
      if (!selected || selected === scenario) await runPauseControlRtc(scenario)
    }
  },
)

const bytes = (wire: string) => new TextEncoder().encode(wire)
test('fixture IPC parses a single UTF8 response without evaluating contents', () => {
  assert.deepEqual(
    parsePauseFixtureResponse(bytes('{"value":"pausa\\n☃"}\n')),
    { value: 'pausa\n☃' },
  )
})
test('fixture IPC enforces byte capacity including final newline', () => {
  const exact = '"' + 'a'.repeat(65533) + '"\n'
  assert.equal(bytes(exact).byteLength, 65536)
  assert.equal(typeof parsePauseFixtureResponse(bytes(exact)), 'string')
  assert.throws(() => parsePauseFixtureResponse(bytes(exact.replace('a', '☃'))))
  assert.throws(() =>
    parsePauseFixtureResponse(bytes('"' + 'a'.repeat(65534) + '"\n')),
  )
})
test('fixture IPC refuses invalid UTF8, concatenated records and missing terminator', () => {
  for (const wire of ['{}', '{}\n{}\n', '\n', '{bad}\n'])
    assert.throws(() => parsePauseFixtureResponse(bytes(wire)))
  assert.throws(() =>
    parsePauseFixtureResponse(new Uint8Array([34, 255, 34, 10])),
  )
})
test('fixture child rejection cannot be mistaken for a successful reply', () => {
  assert.throws(
    () => parsePauseFixtureResponse(bytes('{"error":"synthetic failure"}\n')),
    /Child command rejected/,
  )
})
function closedReceipt() {
  return {
    diagnostics: {
      proofsReady: false,
      sentProofs: 1,
      receivedProofs: 1,
      terminal: true,
      commandsEnabled: false,
      pending: 0,
      retainedBytes: 0,
      certificateMatched: true,
      closeCount: 1,
      cleanupFailures: 0,
    },
    phases: [],
    terminals: 1,
    settled: true,
  }
}
test('fixture cleanup acceptance requires all independent terminal and drain facts', () => {
  assert.doesNotThrow(() => assertPauseFixtureClosed(closedReceipt()))
  for (const delta of [
    { terminal: false },
    { pending: 1 },
    { retainedBytes: 1 },
    { commandsEnabled: true },
    { closeCount: 0 },
    { closeCount: 2 },
    { cleanupFailures: 1 },
  ]) {
    const receipt = closedReceipt()
    assert.throws(() =>
      assertPauseFixtureClosed({
        ...receipt,
        diagnostics: { ...receipt.diagnostics, ...delta },
      }),
    )
  }
})
test('fixture cleanup does not infer settlement or once-only terminal callback', () => {
  for (const delta of [{ settled: false }, { terminals: 0 }, { terminals: 2 }])
    assert.throws(() =>
      assertPauseFixtureClosed({ ...closedReceipt(), ...delta }),
    )
  assert.throws(() => assertPauseFixtureClosed({}))
})
