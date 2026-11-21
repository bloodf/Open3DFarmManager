import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/signalling-runtime-fixture.ts'

test('unauthenticated upgrades from one source cannot block a proven Connector', async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 16; i++) {
      const peer = f.peer('connector')
      Object.defineProperty(peer.raw.socket, 'remoteAddress', {
        value: '192.0.2.1',
      })
      const result = await f.runtime.upgrade(peer.request, 'connector')
      assert.equal(result?.status, i < 2 ? undefined : 403)
    }
    const peer = f.peer('connector')
    Object.defineProperty(peer.raw.socket, 'remoteAddress', {
      value: '192.0.2.2',
    })
    assert.equal(await f.runtime.upgrade(peer.request, 'connector'), undefined)
    f.runtime.open(peer)
    await f.send(peer, {
      v: 1,
      t: 'connector.begin',
      farm_id: f.farm,
      agent_id: f.agent,
      jti: f.jti,
      token: f.token,
    })
    const challenge = peer.wires.at(-1)
    assert.equal(challenge?.t, 'connector.inbox-challenge')
    if (challenge?.t !== 'connector.inbox-challenge')
      throw new Error('Missing challenge')
    await f.send(peer, {
      v: 1,
      t: 'connector.inbox-proof',
      signature: await f.sign(challenge.challenge),
    })
    assert.equal(peer.wires.at(-2)?.t, 'connector.inbox-ready')
  } finally {
    f.close()
  }
})
