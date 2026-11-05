import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeSignallingClientFrame,
  decodeSignallingServerFrame,
  encodeSignallingServerFrame,
  MAX_SIGNALLING_SOCKET_BYTES,
} from '../../packages/farm-protocol/src/signalling-socket.ts'
const id = '2d0a9886-7fa7-4d36-9477-aa5e3816a914'
const begin = {
  v: 1,
  t: 'browser.begin',
  farm_id: id,
  agent_id: id,
  key_id: id,
}
test('client admission metadata has no caller-selected transport/session/authority fields', () => {
  assert.deepEqual(decodeSignallingClientFrame(JSON.stringify(begin)), begin)
  for (const extra of [
    { transport_id: id },
    { account_id: 'account_text' },
    { session_id: 'session_text' },
    { verified: true },
    { commands_enabled: true },
  ])
    assert.throws(() =>
      decodeSignallingClientFrame(JSON.stringify({ ...begin, ...extra })),
    )
  for (const t of [
    'printer.command',
    'camera.frame',
    'status',
    'browser.begin?token=secret',
  ])
    assert.throws(() =>
      decodeSignallingClientFrame(JSON.stringify({ v: 1, t })),
    )
})
test('byte bounds apply to UTF8 before JSON parsing and reject duplicate/unknown keys', () => {
  assert.throws(() =>
    decodeSignallingClientFrame(
      'é'.repeat(MAX_SIGNALLING_SOCKET_BYTES / 2 + 1),
    ),
  )
  assert.throws(() =>
    decodeSignallingClientFrame(' '.repeat(MAX_SIGNALLING_SOCKET_BYTES + 1)),
  )
  assert.throws(() =>
    decodeSignallingClientFrame('{"v":1,"v":1,"t":"connector.retry"}'),
  )
  assert.deepEqual(
    decodeSignallingClientFrame('{"v":1,"t":"connector.retry"}'),
    { v: 1, t: 'connector.retry' },
  )
})
test('server lease metadata is strict, short-lived and always commands-disabled', () => {
  const ready = {
    v: 1,
    t: 'rtc.ready',
    transport_id: id,
    issued_at: 1000,
    expires_at: 9000,
    commands_enabled: false,
  }
  assert.deepEqual(decodeSignallingServerFrame(JSON.stringify(ready)), ready)
  assert.equal(
    encodeSignallingServerFrame(
      decodeSignallingServerFrame(JSON.stringify(ready)),
    ),
    JSON.stringify(ready),
  )
  for (const change of [
    { expires_at: 1000 },
    { expires_at: 31_001 },
    { commands_enabled: true },
    { token: 'secret' },
  ])
    assert.throws(() =>
      decodeSignallingServerFrame(JSON.stringify({ ...ready, ...change })),
    )
  assert.throws(() =>
    decodeSignallingServerFrame(
      JSON.stringify({
        v: 1,
        t: 'retry',
        phase: 'telemetry',
        retry_after_ms: 1000,
      }),
    ),
  )
})
