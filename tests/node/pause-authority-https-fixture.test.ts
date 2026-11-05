import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import {
  createPauseAuditClient,
  servePauseAudit,
  PauseHttpsAuditRequest,
  PauseHttpsAuditReceipt,
  type PauseAuditPort,
} from '../helpers/pause-authority-https-audit.ts'
import {
  createPauseAuthorityHttpsFixtureExtension,
  escapedFixtureObject,
  fixtureCredentialJti,
} from '../helpers/pause-authority-https-acceptance.ts'

function ports() {
  const left = new EventEmitter(),
    right = new EventEmitter()
  let connected = true
  const port = (own: EventEmitter, other: EventEmitter): PauseAuditPort => ({
    connected: () => connected,
    send(value, callback) {
      if (!connected) {
        callback(new Error('closed'))
        return
      }
      other.emit('message', value)
      callback()
    },
    onMessage(listener) {
      own.on('message', listener)
      return () => {
        own.off('message', listener)
      }
    },
    onDisconnect(listener) {
      own.on('disconnect', listener)
      return () => {
        own.off('disconnect', listener)
      }
    },
  })
  return {
    client: port(left, right),
    server: port(right, left),
    left,
    right,
    disconnect() {
      connected = false
      left.emit('disconnect')
      right.emit('disconnect')
    },
  }
}
const empty = { rows: 0, issued: 0, attempts: 0, row: null } as const

test('pause audit schema rejects arbitrary selectors, malformed UUIDs and extra evidence', () => {
  assert.equal(
    PauseHttpsAuditRequest.safeParse({ stage: 'initial' }).success,
    true,
  )
  for (const input of [
    { stage: 'initial', sql: 'select 1' },
    { stage: 'initial', farmId: randomUUID() },
    { stage: 'pending', transportId: 'not-a-uuid' },
    { stage: 'other' },
  ])
    assert.equal(PauseHttpsAuditRequest.safeParse(input).success, false)
  assert.equal(
    PauseHttpsAuditReceipt.safeParse({ ...empty, token: 'private' }).success,
    false,
  )
  assert.equal(
    PauseHttpsAuditReceipt.safeParse({ ...empty, rows: 4097 }).success,
    false,
  )
})
test('pause audit sequential roundtrips enforce the finite request count and remove listeners', async () => {
  const pair = ports(),
    client = createPauseAuditClient(pair.client)
  let calls = 0
  const closeServer = servePauseAudit(pair.server, async () => {
    calls++
    return empty
  })
  try {
    for (let i = 0; i < 24; i++) {
      assert.deepEqual(await client.request({ stage: 'initial' }), empty)
      await Promise.resolve()
    }
    await assert.rejects(client.request({ stage: 'initial' }), /unavailable/)
    assert.equal(calls, 24)
  } finally {
    client.close()
    await closeServer()
    pair.disconnect()
  }
  assert.equal(pair.left.listenerCount('message'), 0)
  assert.equal(pair.right.listenerCount('message'), 0)
})
test('pause audit keeps pending database work until settlement and rejects concurrent requests', async () => {
  const pair = ports(),
    client = createPauseAuditClient(pair.client)
  let release: (value: typeof empty) => void = () => {}
  const work = new Promise<typeof empty>((resolve) => {
    release = resolve
  })
  const closeServer = servePauseAudit(pair.server, () => work)
  const request = client.request({ stage: 'initial' })
  await assert.rejects(client.request({ stage: 'initial' }), /unavailable/)
  client.close()
  await assert.rejects(request, /disconnected/)
  let settled = false
  const closing = closeServer().then(() => {
    settled = true
  })
  await Promise.resolve()
  assert.equal(settled, false)
  release(empty)
  await closing
  assert.equal(settled, true)
  pair.disconnect()
})
test('pause audit timeout and malformed replies fail closed without waiting in real time', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const pair = ports(),
    client = createPauseAuditClient(pair.client)
  try {
    const pending = client.request({ stage: 'initial' })
    const rejected = assert.rejects(pending, /disconnected/)
    context.mock.timers.tick(3000)
    await rejected
    await assert.rejects(client.request({ stage: 'initial' }), /unavailable/)
  } finally {
    client.close()
    pair.disconnect()
    context.mock.timers.reset()
  }
  const malformed = ports(),
    other = createPauseAuditClient(malformed.client)
  try {
    const pending = other.request({ stage: 'initial' }),
      rejected = assert.rejects(pending, /disconnected/)
    malformed.left.emit('message', {
      kind: 'pause-audit-result',
      id: randomUUID(),
      receipt: empty,
    })
    await rejected
  } finally {
    other.close()
    malformed.disconnect()
  }
})
test('credential lookup accepts a UUID hint without asserting JWT trust and rejects malformed inputs', () => {
  const jti = randomUUID()
  assert.equal(
    fixtureCredentialJti(
      `unverified.${Buffer.from(JSON.stringify({ jti })).toString('base64url')}.unverified`,
    ),
    jti,
  )
  for (const token of [
    'a.b.c',
    'a..c',
    'a.b.c.d',
    'x'.repeat(16385),
    `a.${Buffer.from('{"jti":"bad"}').toString('base64url')}.c`,
  ])
    assert.throws(() => fixtureCredentialJti(token))
})
test('pause extension factory performs no identity generation, audit or networking', () => {
  let called = false
  const extension = createPauseAuthorityHttpsFixtureExtension({
    issuer: 'fixture',
    kid: 'fixture',
    audience: 'fixture',
    publicKeySpki: 'A'.repeat(59),
    audit: async () => {
      called = true
      return empty
    },
  })
  assert.equal(typeof extension.identityHandles, 'function')
  assert.equal(typeof extension.afterProvisioned, 'function')
  assert.equal(called, false)
})
test('escaped fixture outer JSON preserves exact inner canonical proof bytes', () => {
  const input = { browserProofWire: '{"v":1,"signature":"abc_123-"}' }
  const wire = escapedFixtureObject(input)
  assert.deepEqual(JSON.parse(wire), input)
  assert.ok(Buffer.byteLength(wire) > Buffer.byteLength(JSON.stringify(input)))
  assert.match(wire, /\\u007b/)
  assert.throws(() => escapedFixtureObject({ wire: 'é' }), /ASCII/)
})
