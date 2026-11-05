import test from 'node:test'
import assert from 'node:assert/strict'
import { BoundedReceive } from '../../packages/connector/src/webrtc/bounded-receive.ts'

test('explicit UTF8 accounting admits four 8192 byte frames including active and retains active charge through terminal', async () => {
  let finish: () => void = () => {}
  const processing = new Promise<void>((resolve) => {
    finish = resolve
  })
  let processed = 0
  let rejected = ''
  const queue = new BoundedReceive({
    limits: {
      frameBytes: 8192,
      pendingFrames: 4,
      retainedBytes: 32768,
      totalFrames: 1024,
    },
    byteAccounting: 'utf8',
    paused: false,
    process: async () => {
      processed++
      await processing
    },
    reject: (reason) => {
      rejected = reason
    },
  })
  const batch = queue.receive('a'.repeat(8192))
  for (let index = 0; index < 3; index++)
    assert.equal(queue.receive('a'.repeat(8192)), batch)
  assert.deepEqual(queue.snapshot(), {
    admitted: 4,
    pending: 4,
    retainedBytes: 32768,
    maxPending: 4,
    maxRetainedBytes: 32768,
  })
  queue.receive('a')
  assert.equal(rejected, 'pending-limit')
  assert.equal(queue.snapshot().retainedBytes, 8192)
  const terminal = queue.snapshot()
  for (let index = 0; index < 100000; index++) queue.receive('x'.repeat(32))
  assert.deepEqual(queue.snapshot(), terminal)
  finish()
  await batch
  assert.equal(processed, 1)
  assert.equal(queue.snapshot().pending, 0)
  assert.equal(queue.snapshot().retainedBytes, 0)
})

test('UTF8 aggregate rejects before enqueue even below slot cap and multibyte wire cap rejects before processing', async () => {
  let reason = ''
  const queue = new BoundedReceive({
    limits: {
      frameBytes: 8192,
      pendingFrames: 4,
      retainedBytes: 10000,
      totalFrames: 1024,
    },
    byteAccounting: 'utf8',
    paused: true,
    process: async () => {
      throw Error('Must remain paused')
    },
    reject: (value) => {
      reason = value
    },
  })
  const batch = queue.receive('é'.repeat(4096))
  queue.receive('a'.repeat(1809))
  assert.equal(reason, 'pending-limit')
  await batch
  assert.deepEqual(queue.snapshot(), {
    admitted: 1,
    pending: 0,
    retainedBytes: 0,
    maxPending: 1,
    maxRetainedBytes: 8192,
  })
  let calls = 0
  const other = new BoundedReceive({
    limits: {
      frameBytes: 8192,
      pendingFrames: 4,
      retainedBytes: 32768,
      totalFrames: 1024,
    },
    byteAccounting: 'utf8',
    paused: false,
    process: async () => {
      calls++
    },
    reject: (value) => {
      reason = value
    },
  })
  await other.receive('é'.repeat(4097))
  assert.equal(reason, 'frame-limit')
  assert.equal(calls, 0)
  assert.equal(other.snapshot().admitted, 0)
})
