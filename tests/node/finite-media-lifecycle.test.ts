import test from 'node:test'
import assert from 'node:assert/strict'
import {
  disposeFiniteResources,
  FixtureProcess,
} from '../../packages/webrtc-experiment/real-identity/native-media-harness.ts'
import { DecodedVideoFixture } from '../../packages/webrtc-experiment/real-identity/decoded-video-fixture.ts'

test('cleanup attempts every resource even when earlier disposals fail', async () => {
  const calls: string[] = []
  await assert.rejects(
    disposeFiniteResources([
      () => {
        calls.push('child')
        throw Error('child')
      },
      async () => {
        calls.push('browser')
        throw Error('browser')
      },
      () => {
        calls.push('server')
      },
    ]),
    AggregateError,
  )
  assert.deepEqual(calls, ['child', 'browser', 'server'])
})

test('stdin failure is handled and permanently denies further fixture IPC', async () => {
  const child = new FixtureProcess('/usr/bin/true')
  try {
    child.process.stdin.emit(
      'error',
      Object.assign(Error('broken pipe'), { code: 'EPIPE' }),
    )
    await assert.rejects(child.request({ kind: 'snapshot' }), /broken pipe/)
  } finally {
    await child.stop()
  }
})

test('video callbacks and delayed stats cannot record beyond the retained lease', async () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  )
  const streamDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'MediaStream',
  )
  let now = 10
  const clock = test.mock.method(performance, 'now', () => now)
  let callback: (() => void) | undefined
  let finishStats: ((value: Map<string, unknown>) => void) | undefined
  let cancelled = false
  let stopped = false
  const video = {
    muted: false,
    playsInline: false,
    srcObject: null as unknown,
    play: async () => {},
    pause: () => {},
    requestVideoFrameCallback: (fn: () => void) => {
      callback = fn
      return 1
    },
    cancelVideoFrameCallback: () => {
      cancelled = true
    },
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (kind: string) =>
        kind === 'video' ? video : { width: 0, height: 0 },
    },
  })
  Object.defineProperty(globalThis, 'MediaStream', {
    configurable: true,
    value: class {},
  })
  const fixture = new DecodedVideoFixture({
    admit: () => 20,
    onTerminal: () => {},
  })
  try {
    fixture.onTrack({
      track: {
        kind: 'video',
        stop: () => {
          stopped = true
        },
      } as unknown as MediaStreamTrack,
      receiver: {
        getStats: () =>
          new Promise((resolve) => {
            finishStats = resolve
          }),
      } as unknown as RTCRtpReceiver,
    })
    fixture.activate({
      binding: { expires_at: Date.now() + 1000 },
      lifetimeDeadline: 20,
    } as Parameters<typeof fixture.activate>[0])
    const pending = fixture.sample()
    now = 20
    callback?.()
    finishStats?.(
      new Map([
        ['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 30 }],
      ]),
    )
    const snapshot = await pending
    assert.equal(snapshot.callbacks, 0)
    assert.equal(snapshot.framesDecoded, 0)
    assert.equal(snapshot.terminal, true)
    assert.equal(snapshot.attached, false)
    assert.equal(cancelled, true)
    assert.equal(stopped, true)
  } finally {
    fixture.stop()
    clock.mock.restore()
    if (documentDescriptor)
      Object.defineProperty(globalThis, 'document', documentDescriptor)
    else Reflect.deleteProperty(globalThis, 'document')
    if (streamDescriptor)
      Object.defineProperty(globalThis, 'MediaStream', streamDescriptor)
    else Reflect.deleteProperty(globalThis, 'MediaStream')
  }
})
