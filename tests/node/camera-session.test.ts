import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalCameraRegistry } from '../../packages/connector/src/camera/source-policy.ts'
import { startCameraSession } from '../../packages/connector/src/camera/session.ts'
import type { CameraAccessUnit } from '../../packages/connector/src/camera/session.ts'

const scope = { farmId: 'farm', agentId: 'agent', printerId: 'printer' }
const registry = createLocalCameraRegistry([
  { cameraId: 'camera', scope, sourceHandle: 'secret' },
])
const unit = (timestampUs = 0): CameraAccessUnit => ({
  data: new Uint8Array([1]),
  keyframe: true,
  timestampUs,
})
function setup(
  openSource: Parameters<typeof startCameraSession>[0]['openSource'],
  result: 'sent' | 'backpressured' | 'closed' = 'sent',
  duration = 1000,
) {
  const controller = new AbortController()
  const sent: CameraAccessUnit[] = []
  let closed = 0
  const session = startCameraSession({
    cameraId: 'camera',
    scope,
    registry,
    lease: {
      cameraId: 'camera',
      scope,
      expiresAt: performance.now() + duration,
      signal: controller.signal,
    },
    openSource,
    sink: {
      trySend(value) {
        sent.push(value)
        return result
      },
      close() {
        closed++
      },
    },
  })
  return { ...session, controller, sent, closed: () => closed }
}
const stream = (values: CameraAccessUnit[]) =>
  async function* () {
    yield* values
  }

test('streams ordered units and closes once', async () => {
  const s = setup(async () => stream([unit(1), unit(2)])())
  await s.done
  s.stop()
  assert.deepEqual(
    s.sent.map((v) => v.timestampUs),
    [1, 2],
  )
  assert.equal(s.closed(), 1)
})

test('rejects invalid units and closes on backpressure', async () => {
  for (const invalid of [
    { ...unit(1), data: new Uint8Array(262_145) },
    unit(NaN),
    unit(Infinity),
    unit(-1),
  ]) {
    const s = setup(async () => stream([unit(), invalid])())
    await s.done
    assert.equal(s.sent.length, 1)
  }
  const s = setup(async () => stream([unit(), unit(1)])(), 'backpressured')
  await s.done
  assert.equal(s.sent.length, 1)
  assert.equal(s.closed(), 1)
})

test('abort interrupts pending next and ignores its late result', async () => {
  let resolveNext: (value: IteratorResult<CameraAccessUnit>) => void = () => {}
  let returned = 0
  const s = setup(async () => ({
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise((resolve) => {
            resolveNext = resolve
          }),
        return: async () => {
          returned++
          return { done: true, value: undefined }
        },
      }
    },
  }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  s.controller.abort()
  await s.done
  resolveNext({ done: false, value: unit() })
  await Promise.resolve()
  assert.equal(s.sent.length, 0)
  assert.equal(returned, 1)
  assert.equal(s.closed(), 1)
})

test('returns an iterator acquired during cancellation exactly once', async () => {
  for (const abortDuringAcquisition of [false, true]) {
    let resolveOpen: (
      source: AsyncIterable<CameraAccessUnit>,
    ) => void = () => {}
    let returned = 0
    let read = 0
    const s = setup(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve
        }),
    )
    resolveOpen({
      [Symbol.asyncIterator]() {
        if (abortDuringAcquisition) s.controller.abort()
        return {
          next: async () => {
            read++
            return { done: false, value: unit() }
          },
          return: async () => {
            returned++
            return { done: true, value: undefined }
          },
        }
      },
    })
    if (!abortDuringAcquisition) s.controller.abort()
    await s.done
    s.stop()
    s.stop()
    assert.equal(returned, 1)
    assert.equal(read, 0)
    assert.equal(s.sent.length, 0)
    assert.equal(s.closed(), 1)
  }
})

test('expiry interrupts pending open and cleans up a late source', async () => {
  let resolveOpen: (source: AsyncIterable<CameraAccessUnit>) => void = () => {}
  let returned = 0
  let signal: AbortSignal | undefined
  const s = setup(
    (_handle, sourceSignal) => {
      signal = sourceSignal
      return new Promise((resolve) => {
        resolveOpen = resolve
      })
    },
    'sent',
    15,
  )
  await s.done
  assert.equal(signal?.aborted, true)
  resolveOpen({
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined }),
        return: async () => {
          returned++
          return { done: true, value: undefined }
        },
      }
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(returned, 1)
  assert.equal(s.sent.length, 0)
})

test('rejects leases outside camera scope and excessive lifetime', async () => {
  for (const lease of [
    { cameraId: 'other', scope, expiresAt: performance.now() + 1000 },
    {
      cameraId: 'camera',
      scope: { ...scope, printerId: 'other' },
      expiresAt: performance.now() + 1000,
    },
    { cameraId: 'camera', scope, expiresAt: performance.now() + 31_000 },
  ]) {
    let opened = false
    let closed = 0
    const session = startCameraSession({
      cameraId: 'camera',
      scope,
      registry,
      lease: { ...lease, signal: new AbortController().signal },
      openSource: async () => {
        opened = true
        return stream([])()
      },
      sink: {
        trySend: () => 'sent',
        close: () => {
          closed++
        },
      },
    })
    await session.done
    assert.equal(opened, false)
    assert.equal(closed, 1)
  }
})

test('enforces unit and byte rates', async () => {
  const fast = setup(async () =>
    stream(Array.from({ length: 31 }, (_, i) => unit(i)))(),
  )
  await fast.done
  assert.equal(fast.sent.length, 30)
  const large = setup(async () =>
    stream(
      Array.from({ length: 5 }, (_, i) => ({
        ...unit(i),
        data: new Uint8Array(262_144),
      })),
    )(),
  )
  await large.done
  assert.equal(large.sent.length, 4)
})

test('copies admitted source bytes before sending', async () => {
  const original = unit(1)
  const s = setup(async () => stream([original])())
  await s.done
  original.data[0] = 9
  assert.deepEqual([...s.sent[0]!.data], [1])
})

test('copies Buffer bytes in both directions and rejects shared memory', async () => {
  const data = Buffer.from([7])
  const s = setup(async () => stream([{ ...unit(1), data }])())
  await s.done
  data[0] = 8
  assert.equal(s.sent[0]!.data[0], 7)
  s.sent[0]!.data[0] = 9
  assert.equal(data[0], 8)
  const shared = setup(async () =>
    stream([{ ...unit(1), data: new Uint8Array(new SharedArrayBuffer(1)) }])(),
  )
  await shared.done
  assert.equal(shared.sent.length, 0)
})

test('requires strictly increasing safe integer stream timestamps', async () => {
  for (const timestampUs of [10, 9, 10.5, Number.MAX_SAFE_INTEGER + 1]) {
    const s = setup(async () => stream([unit(10), unit(timestampUs)])())
    await s.done
    assert.deepEqual(
      s.sent.map((value) => value.timestampUs),
      [10],
    )
  }
  const s = setup(async () => stream([unit(Number.MAX_SAFE_INTEGER)])())
  await s.done
  assert.equal(s.sent.length, 1)
})

test('closes on closed sink and on source or sink exceptions', async () => {
  const closed = setup(async () => stream([unit(), unit(1)])(), 'closed')
  await closed.done
  assert.equal(closed.sent.length, 1)
  assert.equal(closed.closed(), 1)
  const sourceError = setup(async () => {
    throw new Error('secret')
  })
  await sourceError.done
  assert.equal(sourceError.closed(), 1)
  let closeCount = 0
  let returned = 0
  const session = startCameraSession({
    cameraId: 'camera',
    scope,
    registry,
    lease: {
      cameraId: 'camera',
      scope,
      expiresAt: performance.now() + 1000,
      signal: new AbortController().signal,
    },
    openSource: async () => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false, value: unit() }),
          return: async () => {
            returned++
            return { done: true, value: undefined }
          },
        }
      },
    }),
    sink: {
      trySend() {
        throw new Error('secret')
      },
      close() {
        closeCount++
      },
    },
  })
  await session.done
  assert.equal(closeCount, 1)
  assert.equal(returned, 1)
})

test('does not send when reading unit metadata aborts the lease', async () => {
  let controller: AbortController
  const s = setup(async () =>
    stream([
      {
        data: new Uint8Array([1]),
        keyframe: true,
        get timestampUs() {
          controller.abort()
          return 1
        },
      },
    ])(),
  )
  controller = s.controller
  await s.done
  assert.equal(s.sent.length, 0)
  assert.equal(s.closed(), 1)
})
