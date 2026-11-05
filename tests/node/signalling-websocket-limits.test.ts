import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SignallingWebSocketResources,
  type SignallingResourceClock,
} from '../../apps/farm/server/services/signalling-websocket-limits.ts'

function fixture() {
  let now = 0
  const timers = new Map<symbol, { at: number; callback: () => void }>()
  const clock: SignallingResourceClock = {
    now: () => now,
    after(delay, callback) {
      const key = Symbol()
      timers.set(key, { at: now + delay, callback })
      return () => {
        timers.delete(key)
      }
    },
  }
  const resources = new SignallingWebSocketResources(clock)
  function peer() {
    let terminated = 0,
      buffered = 0
    const sent: string[] = []
    const handle = resources.reserve({
      bufferedAmount: () => buffered,
      send: (text) => {
        sent.push(text)
      },
      terminate: () => {
        terminated++
      },
    })
    return {
      handle,
      sent,
      get terminated() {
        return terminated
      },
      setBuffered(value: number) {
        buffered = value
      },
    }
  }
  return {
    resources,
    peer,
    timers,
    setTime(value: number) {
      now = value
    },
    advance(value: number) {
      now = value
      for (const [key, timer] of timers)
        if (timer.at <= now) {
          timers.delete(key)
          timer.callback()
        }
    },
  }
}
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('preauth is bounded; admission never renews original lifetime; disposal closes all', () => {
  const f = fixture()
  const peers = Array.from({ length: 16 }, () => f.peer())
  assert.ok(peers.every((p) => p.handle))
  assert.equal(f.peer().handle, null)
  f.advance(7999)
  const first = peers[0]!
  assert.ok(first.handle)
  assert.equal(f.resources.finishPreauth(first.handle), true)
  f.advance(8000)
  assert.equal(first.terminated, 0)
  assert.ok(peers.slice(1).every((p) => p.terminated === 1))
  f.advance(29_999)
  assert.equal(f.resources.finishPreauth(first.handle), true)
  f.advance(30_000)
  assert.equal(first.terminated, 1)
  assert.equal(f.resources.send(first.handle, 'late'), false)
  f.resources.dispose()
  assert.equal(f.timers.size, 0)
  assert.equal(f.peer().handle, null)
})

test('in-flight bytes, outbound buffering and queued frame count share bounds', async () => {
  const f = fixture(),
    p = f.peer(),
    gate = deferred()
  assert.ok(p.handle)
  const seen: string[] = []
  const process = async (text: string) => {
    seen.push(text)
    await gate.promise
  }
  assert.equal(f.resources.receive(p.handle, 'x'.repeat(12_288), process), true)
  assert.equal(f.resources.receive(p.handle, 'y'.repeat(12_288), process), true)
  assert.equal(f.resources.receive(p.handle, 'z'.repeat(8193), process), false)
  assert.equal(p.terminated, 1)
  gate.release()
  await tick()
  assert.deepEqual(seen, ['x'.repeat(12_288)])
  const q = f.peer()
  assert.ok(q.handle)
  q.setBuffered(32_768)
  assert.equal(f.resources.send(q.handle, 'a'), false)
  assert.equal(q.terminated, 1)
  const r = f.peer(),
    wait = deferred()
  assert.ok(r.handle)
  for (let i = 0; i < 8; i++)
    assert.equal(
      f.resources.receive(r.handle, 'a', () => wait.promise),
      true,
    )
  assert.equal(
    f.resources.receive(r.handle, 'a', () => wait.promise),
    false,
  )
  wait.release()
  await tick()
  f.resources.dispose()
  assert.equal(f.timers.size, 0)
})

test('closed hanging processors retain global capacity and cannot send late', async () => {
  const f = fixture(),
    gate = deferred()
  for (let i = 0; i < 32; i++) {
    const p = f.peer()
    assert.ok(p.handle)
    assert.equal(
      f.resources.receive(p.handle, 'a', () => gate.promise),
      true,
    )
    f.resources.close(p.handle)
    assert.equal(f.resources.send(p.handle, 'late'), false)
  }
  const denied = f.peer()
  assert.ok(denied.handle)
  assert.equal(
    f.resources.receive(denied.handle, 'a', async () => {}),
    false,
  )
  assert.equal(denied.terminated, 1)
  gate.release()
  await tick()
  const next = f.peer()
  assert.ok(next.handle)
  assert.equal(
    f.resources.receive(next.handle, 'a', async () => {}),
    true,
  )
  await tick()
  f.resources.dispose()
})

test('clock regression, expiry across async work and invalid buffer readings fail closed', async () => {
  const f = fixture(),
    p = f.peer(),
    gate = deferred()
  assert.ok(p.handle)
  f.setTime(100)
  assert.equal(f.resources.send(p.handle, 'ok'), true)
  f.setTime(99)
  assert.equal(f.resources.send(p.handle, 'no'), false)
  const q = f.peer()
  assert.ok(q.handle)
  assert.equal(
    f.resources.receive(q.handle, 'a', async () => {
      await gate.promise
      assert.equal(f.resources.send(q.handle!, 'expired'), false)
    }),
    true,
  )
  f.setTime(8099)
  gate.release()
  await tick()
  assert.equal(q.terminated, 1)
  assert.deepEqual(q.sent, [])
  const r = f.peer()
  assert.ok(r.handle)
  r.setBuffered(Number.NaN)
  assert.equal(f.resources.send(r.handle, 'no'), false)
  f.resources.dispose()
})

test('async upgrade work stays bounded after disconnect and drops late identity results', async () => {
  const f = fixture(),
    gate = deferred()
  const results = []
  for (let i = 0; i < 32; i++) {
    const p = f.peer()
    assert.ok(p.handle)
    results.push(
      f.resources.work(p.handle, async () => {
        await gate.promise
        return 'sealed-session-record'
      }),
    )
    f.resources.close(p.handle)
  }
  const next = f.peer()
  assert.ok(next.handle)
  let executed = false
  assert.deepEqual(
    await f.resources.work(next.handle, async () => {
      executed = true
    }),
    { ok: false },
  )
  assert.equal(executed, false)
  gate.release()
  assert.deepEqual(
    await Promise.all(results),
    Array.from({ length: 32 }, () => ({ ok: false })),
  )
  f.resources.dispose()
  assert.equal(f.timers.size, 0)
})
