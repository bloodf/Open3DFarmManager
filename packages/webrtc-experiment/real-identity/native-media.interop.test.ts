import test from 'node:test'
import assert from 'node:assert/strict'
import { movingPixels, MOVING_H264_FIXTURE } from './moving-h264-source.ts'

test('original moving fixture has deterministic distinct pixels and a bounded input sequence', () => {
  const first = movingPixels(0),
    next = movingPixels(1)
  assert.equal(first.byteLength, 49152)
  assert.deepEqual(movingPixels(0), first)
  const pixel = (bytes: Uint8ClampedArray, x: number, y: number) =>
    bytes[(y * 128 + x) * 4]
  assert.equal(pixel(first, 8, 48), 255)
  assert.equal(pixel(next, 8, 48), 0)
  assert.equal(pixel(first, 24, 48), 0)
  assert.equal(pixel(next, 24, 48), 255)
  assert.equal(pixel(first, 8, 8), 0)
  assert.equal(pixel(next, 8, 8), 255)
  assert.equal(MOVING_H264_FIXTURE.frames, 30)
  for (const invalid of [-1, 30, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => movingPixels(invalid))
})

// Actual WebCodecs capability and native/Chromium decode runs are intentionally
// absent from this static checkpoint. They require separately scheduled resources
// and must assert decoded frames and moving pixels, not merely an ontrack event.
