import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { runSignallingLifecycle } from '../../packages/connector/src/runtime/signalling.ts'
import {
  credentialLookupId,
  RuntimeSignalling,
} from '../../packages/connector/src/config/signalling.ts'

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const scope = {
  endpoint: 'wss://farm.example/api/signalling/connector',
  origin: 'https://farm.example',
  audience: 'farm',
}
const policy = {
  credentialExpiresAt: Date.now() + 10000,
  retryMinMs: 5,
  retryMaxMs: 10,
}

test('runtime signalling accepts only the exact trusted HTTPS/WSS scope', () => {
  assert.equal(RuntimeSignalling.parse(scope).retryMinMs, 1000)
  for (const endpoint of [
    'ws://farm.example/api/signalling/connector',
    'wss://foreign.example/api/signalling/connector',
    scope.endpoint + '?token=x',
    scope.endpoint + '#x',
    'wss://user@farm.example/api/signalling/connector',
    'wss://farm.example/other',
  ])
    assert.equal(
      RuntimeSignalling.safeParse({ ...scope, endpoint }).success,
      false,
    )
  assert.equal(
    RuntimeSignalling.safeParse({ ...scope, retryMinMs: 200, retryMaxMs: 100 })
      .success,
    false,
  )
})

test('credential lookup extracts only a bounded canonical payload hint', () => {
  const jti = '00000000-0000-4000-8000-000000000001'
  const payload = Buffer.from(
    JSON.stringify({ jti, untrusted: true }),
  ).toString('base64url')
  assert.equal(credentialLookupId('e30.' + payload + '.AA'), jti)
  for (const token of [
    'bad',
    'e30.' + payload + '=.AA',
    'e30._w.AA',
    'e30.e30.AA',
    'x'.repeat(8193),
  ])
    assert.throws(() => credentialLookupId(token))
})

test('admission does not reconnect and abort joins disposal', async () => {
  const controller = new AbortController(),
    disposing = deferred(),
    disposed = deferred()
  let creates = 0,
    closes = 0,
    completed = false
  const running = runSignallingLifecycle({
    ...policy,
    signal: controller.signal,
    createSession() {
      creates++
      return {
        start: async () => {},
        close: () => {
          closes++
        },
        dispose: async () => {
          disposing.resolve()
          await disposed.promise
        },
      }
    },
  }).then(() => {
    completed = true
  })
  await tick()
  assert.equal(creates, 1)
  assert.equal(closes, 0)
  controller.abort()
  await disposing.promise
  assert.equal(completed, false)
  disposed.resolve()
  await running
  assert.equal(creates, 1)
  assert.ok(closes >= 1)
})

test('terminal notification cannot create a replacement before disposal settles', async () => {
  const controller = new AbortController(),
    disposed = deferred(),
    entered = deferred()
  let terminal = () => {},
    creates = 0
  const running = runSignallingLifecycle({
    ...policy,
    signal: controller.signal,
    createSession(done) {
      creates++
      terminal = done
      return {
        start: async () => {},
        close() {},
        dispose: async () => {
          entered.resolve()
          await disposed.promise
        },
      }
    },
  })
  terminal()
  await entered.promise
  await tick()
  assert.equal(creates, 1)
  controller.abort()
  disposed.resolve()
  await running
  assert.equal(creates, 1)
})

test('failed disposal prevents retry and propagates failure', async () => {
  let creates = 0
  await assert.rejects(
    runSignallingLifecycle({
      ...policy,
      signal: new AbortController().signal,
      createSession(done) {
        creates++
        return {
          start: async () => {
            done()
          },
          close() {},
          dispose: async () => {
            throw Error('disposal failed')
          },
        }
      },
    }),
    /disposal failed/,
  )
  assert.equal(creates, 1)
})

test('synchronous terminal creation skips start but still disposes', async () => {
  const controller = new AbortController()
  let starts = 0,
    disposals = 0
  await runSignallingLifecycle({
    ...policy,
    signal: controller.signal,
    createSession(done) {
      done()
      controller.abort()
      return {
        start: async () => {
          starts++
        },
        close() {},
        dispose: async () => {
          disposals++
        },
      }
    },
  })
  assert.equal(starts, 0)
  assert.equal(disposals, 1)
})

test('credential expiry closes an admitted session without another attempt', async () => {
  let creates = 0,
    closes = 0,
    disposals = 0
  await runSignallingLifecycle({
    ...policy,
    credentialExpiresAt: Date.now() + 30,
    signal: new AbortController().signal,
    createSession() {
      creates++
      return {
        start: async () => {},
        close() {
          closes++
        },
        dispose: async () => {
          disposals++
        },
      }
    },
  })
  assert.equal(creates, 1)
  assert.ok(closes > 0)
  assert.equal(disposals, 1)
})

test('expiry timer is terminal even when it fires before the sampled clock deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  const credentialExpiresAt = Date.now() + 10000
  let creates = 0,
    disposals = 0
  const running = runSignallingLifecycle({
    ...policy,
    credentialExpiresAt,
    signal: controller.signal,
    createSession() {
      creates++
      return {
        start: async () => {},
        close() {},
        dispose: async () => {
          disposals++
        },
      }
    },
  })
  try {
    // Advance the scheduler independently: real Date/performance clocks have
    // not reached the sampled deadline, just as with an early rounded timer.
    t.mock.timers.tick(10000)
    await tick()
    assert.ok(Date.now() < credentialExpiresAt)
    t.mock.timers.tick(policy.retryMinMs)
    await tick()
    assert.equal(creates, 1)
    assert.equal(disposals, 1)
  } finally {
    controller.abort()
    await running
  }
})
