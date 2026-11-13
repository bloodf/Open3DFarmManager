// SPDX-License-Identifier: MIT
import { type Socket } from 'node:net'
import { createServer, type TlsOptions } from 'node:tls'

/** Original bounded MQTT 3.1.1 synthetic broker. No actuator support. */
export function createSyntheticMqtt(tls: TlsOptions) {
  const clients = new Map<Socket, Set<string>>()
  let telemetry = {
    model: 'SYNTHETIC Kobra X',
    firmware: 'SYNTHETIC',
    state: 'idle',
  }
  const field = (value: string) => {
    const bytes = Buffer.from(value)
    const length = Buffer.alloc(2)
    length.writeUInt16BE(bytes.length)
    return Buffer.concat([length, bytes])
  }
  const packet = (type: number, body: Buffer) => {
    const length: number[] = []
    let remaining = body.length
    do {
      let digit = remaining % 128
      remaining = Math.floor(remaining / 128)
      if (remaining) digit |= 128
      length.push(digit)
    } while (remaining)
    return Buffer.concat([Buffer.from([type, ...length]), body])
  }
  const publish = () => {
    for (const [socket, topics] of clients)
      for (const topic of topics) {
        if (!topic.includes('+'))
          socket.write(
            packet(
              0x30,
              Buffer.concat([
                field(
                  topic.endsWith('/#')
                    ? topic.slice(0, -1) + 'status/report'
                    : topic,
                ),
                Buffer.from(
                  JSON.stringify({
                    type: 'status',
                    action: 'query',
                    state: 'done',
                    data: telemetry,
                  }),
                ),
              ]),
            ),
          )
      }
  }
  const server = createServer({ ...tls, handshakeTimeout: 3000 }, (socket) => {
    clients.set(socket, new Set())
    socket.setTimeout(3000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('close', () => clients.delete(socket))
    let buffer = Buffer.alloc(0)
    let connected = false
    socket.on('data', (chunk) => {
      if (buffer.length + chunk.length > 8192) {
        socket.destroy()
        return
      }
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 2) {
        let length = 0,
          multiplier = 1,
          offset = 1
        while (true) {
          const digit = buffer[offset]
          if (digit === undefined) return
          offset++
          length += (digit & 127) * multiplier
          if (length > 4096 || offset > 5) {
            socket.destroy()
            return
          }
          if (!(digit & 128)) break
          multiplier *= 128
        }
        if (buffer.length < offset + length) return
        const header = buffer[0]
        const body = buffer.subarray(offset, offset + length)
        buffer = buffer.subarray(offset + length)
        if (
          header === 0x10 &&
          !connected &&
          body.length >= 12 &&
          body.subarray(0, 7).equals(Buffer.from([0, 4, 77, 81, 84, 84, 4]))
        ) {
          connected = true
          socket.write(Buffer.from([0x20, 2, 0, 0]))
        } else if (connected && header === 0x82 && body.length >= 5) {
          let cursor = 2
          const topics: string[] = []
          while (cursor < body.length) {
            if (cursor + 2 > body.length) {
              socket.destroy()
              return
            }
            const size = body.readUInt16BE(cursor)
            cursor += 2
            if (
              !size ||
              cursor + size >= body.length ||
              body[cursor + size] !== 0
            ) {
              socket.destroy()
              return
            }
            topics.push(body.subarray(cursor, cursor + size).toString())
            cursor += size + 1
          }
          for (const topic of topics) clients.get(socket)?.add(topic)
          socket.write(
            packet(
              0x90,
              Buffer.from([body[0] ?? 0, body[1] ?? 0, ...topics.map(() => 0)]),
            ),
          )
          publish()
        } else if (connected && header === 0xc0 && !body.length)
          socket.write(Buffer.from([0xd0, 0]))
        else if (connected && header === 0xe0 && !body.length) socket.end()
        else {
          socket.destroy()
          return
        }
      }
    })
  })
  return {
    server,
    async start(port = 0, host = '127.0.0.1') {
      if (host !== '127.0.0.1' && host !== '::1')
        throw new Error('Synthetic loopback only')
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      return server.address()
    },
    setTelemetry(value: typeof telemetry) {
      telemetry = { ...value }
      publish()
    },
    async stop() {
      for (const socket of clients.keys()) socket.destroy()
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
    },
  }
}
