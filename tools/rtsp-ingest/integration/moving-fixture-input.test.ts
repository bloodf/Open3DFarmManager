// SPDX-License-Identifier: MIT
// Source-only regressions. Execution requires a separately scheduled Node gate.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import {
  readMovingSummary,
  writeMovingAU,
  writeMovingHeader,
} from './moving-fixture-input.ts'

const signal = (): AbortSignal => new AbortController().signal

function summary(frames: number): Buffer {
  const data = Buffer.alloc(32 + 32 * frames)
  data.write('RTS2')
  data.writeUInt32BE(1, 4)
  data.writeUInt32BE(1, 12)
  data.writeUInt32BE(frames, 16)
  data.writeUInt32BE(frames, 20)
  data.writeUInt32BE(3972, 24)
  data.writeUInt16BE(frames, 28)
  for (let i = 0; i < frames; i++) data.fill(i, 32 + i * 32, 64 + i * 32)
  return data
}

test('moving private v2 header and immutable v1 AU record', async () => {
  const writes: Buffer[] = []
  const pipe = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      writes.push(chunk)
      callback()
    },
  })
  await writeMovingHeader(pipe, { port: 18554, frames: 30 }, signal())
  assert.equal(writes[0]?.toString('hex'), '0201487a001e0000')
  const bytes = Uint8Array.of(0x65, 0x11)
  const pending = writeMovingAU(
    pipe,
    { data: bytes, keyframe: true, timestampUs: 100000 },
    signal(),
  )
  bytes.fill(0)
  await pending
  assert.equal(
    writes[1]?.toString('hex'),
    '0000000e0101000000000000000186a06511',
  )
  pipe.destroy()
})

test('moving rejects malformed source framing before writes', async () => {
  let writes = 0
  const pipe = new Writable({
    write(_chunk, _encoding, callback) {
      writes++
      callback()
    },
  })
  for (const port of [0, 65536, 1.5])
    await assert.rejects(
      writeMovingHeader(pipe, { port, frames: 30 }, signal()),
    )
  for (const frames of [0, 61, NaN])
    await assert.rejects(
      writeMovingHeader(pipe, { port: 18554, frames }, signal()),
    )
  for (const data of [new Uint8Array(), new Uint8Array(262145)])
    await assert.rejects(
      writeMovingAU(pipe, { data, keyframe: true, timestampUs: 0 }, signal()),
    )
  for (const timestampUs of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(
      writeMovingAU(
        pipe,
        { data: Uint8Array.of(1), keyframe: true, timestampUs },
        signal(),
      ),
    )
  await assert.rejects(
    writeMovingAU(
      pipe,
      { data: Uint8Array.of(1), keyframe: false, timestampUs: 0 },
      signal(),
    ),
  )
  assert.equal(writes, 0)
  pipe.destroy()
})

test('moving write pressure and abort are terminal without a queue', async () => {
  let writes = 0
  let finish: (() => void) | undefined
  const pipe = new Writable({
    write(_chunk, _encoding, callback) {
      writes++
      finish = callback
    },
  })
  const controller = new AbortController()
  const first = writeMovingHeader(
    pipe,
    { port: 18554, frames: 30 },
    controller.signal,
  )
  const firstRejected = assert.rejects(first)
  await assert.rejects(
    writeMovingAU(
      pipe,
      { data: Uint8Array.of(1), keyframe: true, timestampUs: 0 },
      signal(),
    ),
  )
  controller.abort()
  await firstRejected
  finish?.()
  await assert.rejects(
    writeMovingHeader(pipe, { port: 18554, frames: 30 }, signal()),
  )
  assert.equal(writes, 1)
  pipe.destroy()
})

test('moving summary accepts bounded fragmented or coalesced hashes and EOF', async () => {
  for (const frames of [1, 30, 60]) {
    const data = summary(frames)
    for (const chunks of [
      [data],
      [data.subarray(0, 3), data.subarray(3, 31), data.subarray(31)],
    ]) {
      const pipe = Readable.from(chunks, { objectMode: false })
      const result = await readMovingSummary(pipe, { frames }, signal())
      assert.equal(result.accessUnits, frames)
      assert.equal(result.canonicalSHA256.length, frames)
      assert.equal(
        result.canonicalSHA256[frames - 1],
        Buffer.alloc(32, frames - 1).toString('hex'),
      )
    }
  }
})

test('moving summary rejects malformed, extra, truncated and cancelled status', async () => {
  const valid = summary(30)
  const mutations: Buffer[] = [
    valid.subarray(0, valid.length - 1),
    Buffer.concat([valid, Buffer.of(0)]),
  ]
  for (const [offset, value] of [
    [0, 0],
    [7, 2],
    [11, 1],
    [15, 2],
    [19, 29],
    [23, 0],
    [31, 1],
  ]) {
    if (offset === undefined || value === undefined)
      throw new Error('invalid test mutation')
    const data = Buffer.from(valid)
    data[offset] = value
    mutations.push(data)
  }
  for (const bytes of mutations)
    await assert.rejects(
      readMovingSummary(
        Readable.from([bytes], { objectMode: false }),
        { frames: 30 },
        signal(),
      ),
    )
  const pipe = new Readable({ read() {} })
  const controller = new AbortController()
  const pending = readMovingSummary(pipe, { frames: 30 }, controller.signal)
  const rejected = assert.rejects(pending)
  controller.abort()
  await rejected
  assert.equal(pipe.listenerCount('readable'), 0)
  await assert.rejects(readMovingSummary(pipe, { frames: 30 }, signal()))
  pipe.destroy()
})

test('moving failed writer and pre-abort never admit a later record', async () => {
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('private error'))
    },
  })
  await assert.rejects(
    writeMovingHeader(broken, { port: 18554, frames: 30 }, signal()),
    { message: 'MOVING_FIXTURE_FAILURE' },
  )
  await assert.rejects(
    writeMovingHeader(broken, { port: 18554, frames: 30 }, signal()),
  )
  let writes = 0
  const pipe = new Writable({
    write(_chunk, _encoding, callback) {
      writes++
      callback()
    },
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    writeMovingHeader(pipe, { port: 18554, frames: 30 }, controller.signal),
  )
  assert.equal(writes, 0)
  pipe.destroy()
  broken.destroy()
})

test('moving abort keeps late write errors contained until owner disposal closes', async () => {
  for (const ownerDisposesFirst of [true, false]) {
    let writeDone: ((error?: Error | null) => void) | undefined
    const pipe = new Writable({
      write(_chunk, _encoding, callback) {
        writeDone = callback
      },
    })
    const controller = new AbortController()
    const pending = writeMovingHeader(
      pipe,
      { port: 18554, frames: 30 },
      controller.signal,
    )
    const rejected = assert.rejects(pending, {
      message: 'MOVING_FIXTURE_FAILURE',
    })
    controller.abort()
    await rejected
    const closed = new Promise<void>((resolve) => pipe.once('close', resolve))
    // Both owner disposal and a delayed failed _write may emit an error after
    // the caller has already observed cancellation. Neither may escape.
    if (ownerDisposesFirst) pipe.destroy(new Error('private owner disposal'))
    writeDone?.(new Error('private late write failure'))
    await closed
    pipe.destroy()
    assert.equal(pipe.listenerCount('error'), 0)
    assert.equal(pipe.listenerCount('close'), 0)
    await assert.rejects(
      writeMovingHeader(pipe, { port: 18554, frames: 30 }, signal()),
    )
  }
})
