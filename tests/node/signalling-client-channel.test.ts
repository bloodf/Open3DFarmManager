import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SignallingClientChannel,
  type SocketPort,
} from '../../packages/connector/src/webrtc/signalling-client-channel.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function fixture(
  onFrame: ConstructorParameters<
    typeof SignallingClientChannel
  >[0]['onFrame'] = async () => {},
) {
  let now = 100,
    wall = 100000,
    closed = 0,
    opened = 0
  let handlers: Parameters<SocketPort['bind']>[0] | undefined
  const writes: Array<(error?: Error) => void> = []
  const port: SocketPort = {
    isOpen: () => true,
    bufferedBytes: () => 0,
    bind: (value) => {
      handlers = value
      return () => {}
    },
    send: (_wire, done) => {
      writes.push(done)
    },
    close: () => {
      closed++
    },
  }
  const channel = new SignallingClientChannel({
    onFrame,
    onOpen: () => {
      opened++
    },
    onTerminal: () => {},
    clock: { now: () => now, wallNow: () => wall },
  })
  channel.connect(() => port)
  await tick()
  assert.ok(handlers)
  return {
    channel,
    handlers,
    writes,
    closed: () => closed,
    opened: () => opened,
    advance: (ms: number) => {
      now += ms
      wall += ms
    },
  }
}

test('original admission and lifetime only shorten; terminal late callbacks cannot restart', async () => {
  const f = await fixture()
  try {
    f.advance(1000)
    f.channel.beginContext(120000)
    assert.equal(f.channel.deadlines().authDeadline, 8100)
    f.channel.capLease({ issued_at: 100000, expires_at: 110000 })
    assert.equal(f.channel.deadlines().lifetimeDeadline, 10100)
    f.channel.close()
    f.handlers.open()
    f.handlers.message('x'.repeat(100000))
    await tick()
    assert.equal(f.opened(), 0)
    assert.equal(f.channel.snapshot().work.admitted, 0)
    assert.equal(f.closed(), 1)
  } finally {
    f.channel.close()
  }
})

test('active receive is charged before await and overload stops subsequent callbacks', async () => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(async () => {
    await held
  })
  try {
    const frame = JSON.stringify({
      v: 1,
      t: 'retry',
      phase: 'inbox',
      retry_after_ms: 1,
    })
    for (let i = 0; i < 100000; i++) f.handlers.message(frame)
    const snapshot = f.channel.snapshot()
    assert.equal(snapshot.state, 'readonly')
    assert.equal(snapshot.reason, 'receive-capacity')
    assert.equal(snapshot.work.maxPending, 4)
    assert.ok(snapshot.work.maxRetainedBytes <= 32768)
    assert.equal(snapshot.work.admitted, 4)
    assert.equal(f.closed(), 1)
    release()
    await tick()
    assert.equal(f.channel.snapshot().work.pending, 0)
    assert.equal(f.channel.snapshot().work.retainedBytes, 0)
  } finally {
    release()
    f.channel.close()
  }
})

test('four outstanding writes cap submission and late completions do not revive counters', async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 4; i++) f.channel.send({ v: 1, t: 'connector.retry' })
    assert.equal(f.channel.snapshot().pendingWrites, 4)
    assert.throws(() => f.channel.send({ v: 1, t: 'connector.retry' }))
    for (const done of f.writes) done()
    assert.equal(f.channel.snapshot().state, 'readonly')
    assert.equal(f.channel.snapshot().pendingWrites, 0)
    assert.equal(f.channel.snapshot().writeBytes, 0)
    assert.equal(f.closed(), 1)
  } finally {
    f.channel.close()
  }
})

test('UTF-8 byte budget includes the active frame before asynchronous work settles', async () => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(async () => held)
  try {
    const base = JSON.stringify({
      v: 1,
      t: 'retry',
      phase: 'inbox',
      retry_after_ms: 1,
    })
    const padded = (bytes: number) => ' '.repeat(bytes - base.length) + base
    for (const n of [8192, 8192, 8192]) f.handlers.message(padded(n))
    assert.equal(f.channel.snapshot().work.retainedBytes, 24576)
    f.handlers.message(padded(8193))
    const stopped = f.channel.snapshot()
    assert.equal(stopped.reason, 'receive-capacity')
    assert.equal(stopped.work.admitted, 3)
    assert.equal(stopped.work.retainedBytes, 8192)
    release()
    await tick()
    assert.equal(f.channel.snapshot().work.retainedBytes, 0)
  } finally {
    release()
    f.channel.close()
  }
})

test('oversized UTF-8 and binary frames fail before admission', async () => {
  for (const input of ['é'.repeat(6145), new Uint8Array([1])]) {
    const f = await fixture()
    try {
      f.handlers.message(input)
      assert.equal(f.channel.snapshot().reason, 'receive-capacity')
      assert.equal(f.channel.snapshot().work.admitted, 0)
    } finally {
      f.channel.close()
    }
  }
})

test('socket buffered bytes count against outbound cap', async () => {
  let closed = 0,
    sent = 0
  const port: SocketPort = {
    isOpen: () => true,
    bufferedBytes: () => 32768,
    bind: () => () => {},
    send: () => {
      sent++
    },
    close: () => {
      closed++
    },
  }
  const channel = new SignallingClientChannel({
    onFrame: async () => {},
    onOpen: () => {},
    onTerminal: () => {},
  })
  try {
    channel.connect(() => port)
    await tick()
    assert.throws(() => channel.send({ v: 1, t: 'connector.retry' }))
    assert.equal(sent, 0)
    assert.equal(closed, 1)
  } finally {
    channel.close()
  }
})

test('deadline starts before a delayed factory and closes late port', async () => {
  let now = 0,
    closed = 0,
    bind = 0
  let release: (port: SocketPort) => void = () => {}
  const delayed = new Promise<SocketPort>((resolve) => {
    release = resolve
  })
  const port: SocketPort = {
    isOpen: () => true,
    bufferedBytes: () => 0,
    bind: () => {
      bind++
      return () => {}
    },
    send: () => {},
    close: () => {
      closed++
    },
  }
  const channel = new SignallingClientChannel({
    onFrame: async () => {},
    onOpen: () => {},
    onTerminal: () => {},
    clock: { now: () => now, wallNow: () => 100000 },
  })
  try {
    channel.connect(() => delayed)
    await tick()
    now = 8000
    assert.equal(channel.current(), false)
    release(port)
    await tick()
    assert.equal(closed, 1)
    assert.equal(bind, 0)
  } finally {
    channel.close()
  }
})

test('close between factory resolution and adoption closes the unbound socket', async () => {
  let closed = 0,
    bound = 0
  const port: SocketPort = {
    isOpen: () => true,
    bufferedBytes: () => 0,
    bind: () => {
      bound++
      return () => {}
    },
    send: () => {},
    close: () => {
      closed++
    },
  }
  const channel = new SignallingClientChannel({
    onFrame: async () => {},
    onOpen: () => {},
    onTerminal: () => {},
  })
  try {
    channel.connect(() => port)
    queueMicrotask(() => queueMicrotask(() => channel.close()))
    await tick()
    assert.equal(closed, 1)
    assert.equal(bound, 0)
    assert.equal(channel.current(), false)
  } finally {
    channel.close()
  }
})

test('notification and unbind failures cannot prevent socket cleanup', async () => {
  let handlers: Parameters<SocketPort['bind']>[0] | undefined,
    closed = 0
  const port: SocketPort = {
    isOpen: () => true,
    bufferedBytes: () => 0,
    bind: (h) => {
      handlers = h
      return () => {
        throw Error('unbind')
      }
    },
    send: () => {},
    close: () => {
      closed++
    },
  }
  const channel = new SignallingClientChannel({
    onFrame: async () => {},
    onOpen: () => {},
    onTerminal: () => {
      throw Error('owner')
    },
  })
  channel.connect(() => port)
  await tick()
  handlers?.error()
  assert.equal(channel.snapshot().state, 'readonly')
  assert.equal(closed, 1)
  channel.close()
  assert.equal(closed, 1)
})

test('completed admission keeps lifetime and later cap only shortens it', async () => {
  const f = await fixture()
  try {
    f.channel.completeAdmission()
    assert.equal(f.channel.deadlines().authDeadline, undefined)
    f.advance(1000)
    f.channel.capLease({ issued_at: 100000, expires_at: 110000 })
    assert.equal(f.channel.deadlines().lifetimeDeadline, 10100)
    f.channel.capLease({ issued_at: 100000, expires_at: 120000 })
    assert.equal(f.channel.deadlines().lifetimeDeadline, 10100)
    f.advance(9000)
    assert.equal(f.channel.current(), false)
    assert.equal(f.closed(), 1)
  } finally {
    f.channel.close()
  }
})

test('outstanding write bytes cannot exceed 32 KiB even below four slots', async () => {
  const f = await fixture()
  try {
    const frame = {
      v: 1 as const,
      t: 'connector.attach' as const,
      token: 'a'.repeat(8192),
    }
    for (let i = 0; i < 3; i++) f.channel.send(frame)
    assert.equal(f.channel.snapshot().pendingWrites, 3)
    assert.ok(f.channel.snapshot().writeBytes < 32768)
    assert.throws(() => f.channel.send(frame))
    assert.equal(f.channel.snapshot().reason, 'send-failed')
    assert.equal(f.writes.length, 3)
  } finally {
    f.channel.close()
  }
})
