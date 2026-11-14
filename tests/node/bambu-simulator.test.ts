import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:tls'
import { once } from 'node:events'
import {
  startBambuSimulator,
  packet,
} from '../../packages/sim-tools/src/bambu-simulator.ts'

test(
  'synthetic TLS reports, command rejection and owned socket cleanup',
  { timeout: 10000 },
  async () => {
    const peer = await startBambuSimulator()
    const clients: ReturnType<typeof connect>[] = []
    async function client() {
      const socket = connect({
        host: peer.host,
        port: peer.port,
        ca: peer.syntheticTrust,
      })
      clients.push(socket)
      await once(socket, 'secureConnect')
      const reply = once(socket, 'data')
      socket.write(
        Buffer.from([16, 13, 0, 4, 77, 81, 84, 84, 4, 2, 0, 10, 0, 1, 120]),
      )
      assert.deepEqual((await reply)[0], Buffer.from([32, 2, 0, 0]))
      return socket
    }
    try {
      const socket = await client()
      const topic = Buffer.from(peer.reportTopic)
      const sub = Buffer.alloc(4)
      sub.writeUInt16BE(1)
      sub.writeUInt16BE(topic.length, 2)
      let reply = once(socket, 'data')
      socket.write(packet(130, Buffer.concat([sub, topic, Buffer.from([0])])))
      assert.deepEqual((await reply)[0], Buffer.from([144, 3, 0, 1, 0]))
      for (const value of [{ print: { mc_percent: 7 } }, '{malformed']) {
        reply = once(socket, 'data')
        peer.publishReport(value)
        const bytes = (await reply)[0] as Buffer
        assert.equal(bytes[0], 48)
        assert.ok(
          bytes.includes(
            Buffer.from(
              typeof value === 'string' ? value : JSON.stringify(value),
            ),
          ),
        )
      }
      reply = once(socket, 'data')
      socket.write(Buffer.from([192, 0]))
      assert.deepEqual((await reply)[0], Buffer.from([208, 0]))
      const rejected = once(socket, 'close')
      socket.write(Buffer.from([48, 0]))
      await rejected
      const disconnected = await client()
      const ended = once(disconnected, 'close')
      await peer.disconnectClients()
      await ended
      const final = await client()
      const closed = once(final, 'close')
      await peer.close()
      await closed
      assert.ok(clients.every((client) => client.destroyed))
    } finally {
      for (const socket of clients) socket.destroy()
      await peer.close()
    }
  },
)
