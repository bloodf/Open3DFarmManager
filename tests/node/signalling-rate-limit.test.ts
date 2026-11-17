import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SIGNALLING_MESSAGE_BUCKET_CAPACITY,
  SIGNALLING_MESSAGE_REFILL_PER_SECOND,
  SIGNALLING_RATE_LIMIT_CLOSE_CODE,
} from '../../packages/farm-protocol/src/signalling-socket.ts'
import { acceptSignallingMessage } from '../../apps/farm/server/services/signalling-websocket-limits.ts'

test('a signalling socket accepts a negotiation burst and refills at the documented rate', () => {
  const bucket = { tokens: SIGNALLING_MESSAGE_BUCKET_CAPACITY, updatedAt: 0 }
  const port = {
    bufferedAmount: () => 0,
    send() {},
    terminate() {},
    close(code: number, reason: string) {
      closedWith = { code, reason }
    },
  }
  let closedWith: { code: number; reason: string } | undefined
  for (let i = 0; i < SIGNALLING_MESSAGE_BUCKET_CAPACITY; i++)
    assert.equal(acceptSignallingMessage(bucket, 0, port), true)
  assert.equal(acceptSignallingMessage(bucket, 0, port), false)
  assert.deepEqual(closedWith, {
    code: SIGNALLING_RATE_LIMIT_CLOSE_CODE,
    reason: 'Signalling message rate limit exceeded',
  })
  assert.equal(
    acceptSignallingMessage(
      bucket,
      1000 / SIGNALLING_MESSAGE_REFILL_PER_SECOND,
      port,
    ),
    true,
  )
})

test('normal authenticated SDP negotiation stays below the per-socket limit', async () => {
  const { fixture } = await import('../helpers/signalling-runtime-fixture.ts')
  const f = await fixture()
  try {
    const machine = await f.inbox()
    const browser = await f.browserContext()
    await f.attach(machine)
    const ready = browser.wires.at(-1)
    assert.ok(ready?.t === 'rtc.ready')
    await f.send(machine, {
      v: 1,
      t: 'rtc.offer',
      transport_id: ready.transport_id,
      seq: 0,
      p: {
        sdp: `v=0\r\na=fingerprint:sha-256 ${Array(32).fill('AB').join(':')}\r\n`,
      },
    })
    assert.equal(browser.wires.at(-1)?.t, 'rtc.offer')
    assert.equal(machine.raw.socket.destroyed, false)
    assert.equal(browser.raw.socket.destroyed, false)
  } finally {
    f.close()
  }
})
