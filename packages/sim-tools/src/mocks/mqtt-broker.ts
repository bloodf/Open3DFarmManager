// SPDX-License-Identifier: MIT
import {
  createServer as createTlsServer,
  type Server as TlsServer,
  type TLSSocket,
} from 'node:tls'
import { once } from 'node:events'
import { FaultController, type FaultFilterContext } from './faults.ts'
import { ScenarioController, type ScenarioStep } from './scenario.ts'
import {
  generateThrowawayTls,
  getSharedThrowawayTls,
  type ThrowawayTlsMaterial,
} from './tls.ts'

const MAX_PACKET = 65536

export function encodePacket(header: number, body: Buffer): Buffer {
  const length: number[] = []
  let n = body.length
  do {
    let digit = n % 128
    n = Math.floor(n / 128)
    if (n) digit |= 128
    length.push(digit)
  } while (n)
  return Buffer.concat([Buffer.from([header, ...length]), body])
}

export function matchMqttTopic(filter: string, topic: string): boolean {
  if (filter === topic || filter === '#') return true
  const fParts = filter.split('/')
  const tParts = topic.split('/')
  for (let i = 0; i < fParts.length; i++) {
    const f = fParts[i]!
    if (f === '#') return i === fParts.length - 1
    if (i >= tParts.length) return false
    if (f !== '+' && f !== tParts[i]) return false
  }
  return fParts.length === tParts.length
}

export interface MqttMessage {
  topic: string
  payload: Buffer
  qos: number
  packetId?: number | undefined
  timestamp: number
}

export interface MqttBrokerOptions {
  port?: number | undefined
  /** Listen address; defaults to loopback. Non-loopback is an explicit opt-in (e.g. Docker sandbox). */
  host?: string | undefined
  handshakeTimeout?: number | undefined
  socketTimeout?: number | undefined
  strictConnect?: boolean | undefined
  faults?: FaultController | undefined
  tls?:
    | (
        | { key: Buffer; cert: Buffer; ca?: Buffer | undefined }
        | ThrowawayTlsMaterial
      )
    | undefined
  reuseSharedTls?: boolean | undefined
  scenario?: ScenarioStep[] | undefined
  auth?:
    | {
        username?: string | undefined
        password?: string | undefined
      }
    | undefined
  authorizeSubscribe?:
    ((topic: string, qos: number, socket: TLSSocket) => boolean) | undefined
  onSubscribe?:
    ((topics: string[], socket: TLSSocket) => void | Promise<void>) | undefined
  onPublish?:
    | ((message: MqttMessage, socket: TLSSocket) => void | Promise<void>)
    | undefined
}

export interface MqttMockInstance {
  origin: string
  ports: { default: number; mqtt: number } & number[]
  control: {
    faults: FaultController
    scenario: ScenarioController
    publish: (topic: string, payload: unknown, qos?: 0 | 1) => void
    disconnectClients: () => Promise<void>
    subscriptions: Map<TLSSocket, Set<string>>
    sockets: Set<TLSSocket>
    tlsMaterial?: ThrowawayTlsMaterial | undefined
  }
  calls: {
    (): Readonly<Record<string, number>>
    all: readonly MqttMessage[]
  }
  close: () => Promise<void>
}

export async function startMqttBroker(
  options: MqttBrokerOptions = {},
): Promise<MqttMockInstance> {
  const faults = options.faults ?? new FaultController()
  const sockets = new Set<TLSSocket>()
  const subscriptions = new Map<TLSSocket, Set<string>>()
  const messages: MqttMessage[] = []
  const callCounts: Record<string, number> = {}
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

  let ownedTlsMaterial: ThrowawayTlsMaterial | undefined
  let activeTlsMaterial: ThrowawayTlsMaterial | undefined
  let serverKey: Buffer
  let serverCert: Buffer

  if (options.tls) {
    if ('server' in options.tls) {
      activeTlsMaterial = options.tls
      serverKey = options.tls.server.key
      serverCert = options.tls.server.cert
    } else {
      serverKey = options.tls.key
      serverCert = options.tls.cert
    }
  } else if (options.reuseSharedTls) {
    const shared = getSharedThrowawayTls()
    activeTlsMaterial = shared
    serverKey = shared.server.key
    serverCert = shared.server.cert
  } else {
    ownedTlsMaterial = generateThrowawayTls()
    activeTlsMaterial = ownedTlsMaterial
    serverKey = ownedTlsMaterial.server.key
    serverCert = ownedTlsMaterial.server.cert
  }

  const recordCall = (key: string) => {
    callCounts[key] = (callCounts[key] ?? 0) + 1
  }

  async function disconnectClients(): Promise<void> {
    await Promise.all(
      [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.destroyed) {
              resolve()
              return
            }
            socket.once('close', () => resolve())
            socket.destroy()
          }),
      ),
    )
  }

  function emitToSubscribers(topic: string, payload: unknown, qos: 0 | 1 = 0) {
    const buffer = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(
          typeof payload === 'string' ? payload : JSON.stringify(payload),
        )
    if (buffer.length > MAX_PACKET - 256) {
      throw new Error('Report too large')
    }
    const topicBuf = Buffer.from(topic)
    const lenBuf = Buffer.alloc(2)
    lenBuf.writeUInt16BE(topicBuf.length)

    let body: Buffer
    let header: number
    if (qos === 1) {
      header = 0x32
      const idBuf = Buffer.alloc(2)
      idBuf.writeUInt16BE(1)
      body = Buffer.concat([lenBuf, topicBuf, idBuf, buffer])
    } else {
      header = 0x30
      body = Buffer.concat([lenBuf, topicBuf, buffer])
    }

    const pkt = encodePacket(header, body)

    for (const [sock, topics] of subscriptions.entries()) {
      if (!sock.writable) continue
      let matched = false
      for (const filter of topics) {
        if (matchMqttTopic(filter, topic)) {
          matched = true
          break
        }
      }
      if (matched) {
        if (sock.writableLength > MAX_PACKET) {
          sock.destroy()
        } else {
          sock.write(pkt)
        }
      }
    }
  }

  function publishToSubscribers(
    topic: string,
    payload: unknown,
    qos: 0 | 1 = 0,
  ) {
    const fault = faults.matchFault({
      topic,
      packetType: 3,
      method: 'REPORT',
    })
    if (fault) {
      if (fault.type === 'drop') {
        void disconnectClients()
        return
      }
      if (fault.type === 'refuse' || fault.type === 'stall') {
        return
      }
      if (fault.type === 'malformed') {
        emitToSubscribers(topic, fault.payload ?? '{malformed', qos)
        return
      }
      if (fault.type === 'delay') {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer)
          emitToSubscribers(topic, payload, qos)
        }, fault.delayMs)
        pendingTimers.add(timer)
        return
      }
    }
    emitToSubscribers(topic, payload, qos)
  }

  const scenario = new ScenarioController({
    steps: options.scenario,
    applyState: () => {},
    publishReport: (report) => {
      publishToSubscribers('report', report)
    },
    getState: () => ({}),
  })

  const server: TlsServer = createTlsServer(
    {
      key: serverKey,
      cert: serverCert,
      handshakeTimeout: options.handshakeTimeout ?? 5000,
    },
    (socket) => {
      sockets.add(socket)
      subscriptions.set(socket, new Set())

      let buffer = Buffer.alloc(0)
      let connected = false

      if (options.socketTimeout !== undefined) {
        socket.setTimeout(options.socketTimeout, () => socket.destroy())
      }

      socket.on('error', () => {
        // Suppress expected client disconnect errors
      })

      socket.on('close', () => {
        sockets.delete(socket)
        subscriptions.delete(socket)
      })

      socket.on('data', async (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > MAX_PACKET) {
          socket.destroy()
          return
        }

        try {
          while (buffer.length >= 2) {
            let size = 0
            let factor = 1
            let offset = 1
            while (true) {
              if (offset >= buffer.length) return
              const digit = buffer[offset++]!
              size += (digit & 127) * factor
              if (size > MAX_PACKET || offset > 5)
                throw new Error('Packet limit')
              if (!(digit & 128)) break
              factor *= 128
            }

            if (buffer.length < offset + size) return

            const header = buffer[0]!
            const body = buffer.subarray(offset, offset + size)
            buffer = buffer.subarray(offset + size)

            const packetType = header >> 4

            // 1. CONNECT (packet type 1 = 0x10)
            if (!connected && packetType === 1) {
              recordCall('CONNECT')
              const fault = faults.matchFault({
                packetType: 1,
                method: 'CONNECT',
              })
              if (fault) {
                if (fault.type === 'drop') {
                  socket.destroy()
                  return
                }
                if (fault.type === 'refuse') {
                  const returnCode = fault.code ?? 5
                  socket.write(Buffer.from([0x20, 0x02, 0x00, returnCode]))
                  socket.end()
                  return
                }
                if (fault.type === 'malformed') {
                  const bad = fault.payload ?? Buffer.from([0xff, 0xff, 0xff])
                  socket.write(Buffer.isBuffer(bad) ? bad : Buffer.from(bad))
                  socket.destroy()
                  return
                }
                if (fault.type === 'delay') {
                  await new Promise((r) => setTimeout(r, fault.delayMs))
                }
                if (fault.type === 'stall') {
                  return
                }
              }

              // Validate MQTT 3.1.1 protocol string
              if (
                header !== 16 ||
                body.length < 10 ||
                body.subarray(0, 7).toString('hex') !== '00044d51545404'
              ) {
                socket.destroy()
                return
              }

              const flags = body[7]!
              const strict = Boolean(options.strictConnect)
              if (strict && flags !== 2 && flags !== 194 && flags !== 130) {
                socket.destroy()
                return
              }

              let cursor = 10
              const readField = (requireNonEmpty: boolean): string => {
                if (cursor + 2 > body.length) {
                  throw new Error('Missing CONNECT field')
                }
                const len = body.readUInt16BE(cursor)
                cursor += 2
                if ((requireNonEmpty && !len) || cursor + len > body.length) {
                  throw new Error('Invalid CONNECT field')
                }
                const val = body.subarray(cursor, cursor + len).toString('utf8')
                cursor += len
                return val
              }

              readField(strict) // clientId
              if (flags & 0x04) {
                if (strict) throw new Error('Will unsupported')
                readField(false)
                readField(false)
              }
              const username = flags & 0x80 ? readField(strict) : undefined
              const password = flags & 0x40 ? readField(strict) : undefined

              if (strict && cursor !== body.length) {
                throw new Error('Trailing CONNECT bytes')
              }

              if (
                options.auth &&
                ((options.auth.username !== undefined &&
                  username !== options.auth.username) ||
                  (options.auth.password !== undefined &&
                    password !== options.auth.password))
              ) {
                socket.write(Buffer.from([0x20, 0x02, 0x00, 0x05]))
                socket.end()
                return
              }

              connected = true
              socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]))
              continue
            }

            if (!connected) {
              socket.destroy()
              return
            }

            // 2. SUBSCRIBE (packet type 8 = 0x82)
            if (packetType === 8) {
              recordCall('SUBSCRIBE')
              if (
                options.strictConnect &&
                (header !== 130 || body.length < 5)
              ) {
                throw new Error('Invalid subscription')
              }
              const packetIdMsb = body[0]!
              const packetIdLsb = body[1]!
              if (options.strictConnect && body.readUInt16BE(0) === 0) {
                throw new Error('Invalid subscription packetId')
              }
              let cur = 2
              const granted: number[] = []
              const subscribedTopics: string[] = []

              while (cur < body.length) {
                if (cur + 2 > body.length) {
                  throw new Error('Invalid subscription')
                }
                const topicLen = body.readUInt16BE(cur)
                cur += 2
                if (cur + topicLen + 1 > body.length) {
                  throw new Error('Invalid subscription topic')
                }
                const topic = body
                  .subarray(cur, cur + topicLen)
                  .toString('utf8')
                cur += topicLen
                const qos = body[cur++] ?? 0

                if (options.strictConnect && qos !== 0) {
                  throw new Error('Only QoS 0 supported')
                }

                recordCall(`SUBSCRIBE:${topic}`)

                const fault = faults.matchFault({
                  topic,
                  packetType: 8,
                  method: 'SUBSCRIBE',
                })
                if (fault) {
                  if (fault.type === 'drop') {
                    socket.destroy()
                    return
                  }
                  if (fault.type === 'refuse') {
                    granted.push(0x80)
                    continue
                  }
                  if (fault.type === 'malformed') {
                    const bad = fault.payload ?? Buffer.from([0x90, 0x01, 0xff])
                    socket.write(Buffer.isBuffer(bad) ? bad : Buffer.from(bad))
                    socket.destroy()
                    return
                  }
                  if (fault.type === 'delay') {
                    await new Promise((r) => setTimeout(r, fault.delayMs))
                  }
                  if (fault.type === 'stall') {
                    return
                  }
                }

                const allowed =
                  qos <= 1 &&
                  (!options.authorizeSubscribe ||
                    options.authorizeSubscribe(topic, qos, socket))

                if (allowed) {
                  subscriptions.get(socket)?.add(topic)
                  subscribedTopics.push(topic)
                  granted.push(qos)
                } else {
                  granted.push(0x80)
                }
              }

              socket.write(
                Buffer.concat([
                  Buffer.from([
                    0x90,
                    2 + granted.length,
                    packetIdMsb,
                    packetIdLsb,
                  ]),
                  Buffer.from(granted),
                ]),
              )

              if (subscribedTopics.length > 0 && options.onSubscribe) {
                await options.onSubscribe(subscribedTopics, socket)
              }
              continue
            }

            // 3. PUBLISH (packet type 3 = 0x30 / 0x32)
            if (packetType === 3) {
              if (body.length < 2) {
                throw new Error('Invalid request')
              }
              const qos = (header >> 1) & 0x03
              const topicLen = body.readUInt16BE(0)
              if (2 + topicLen > body.length) {
                throw new Error('Invalid publish topic')
              }
              const topic = body.subarray(2, 2 + topicLen).toString('utf8')
              let payloadOffset = 2 + topicLen
              let packetId: number | undefined

              if (qos === 1) {
                if (payloadOffset + 2 > body.length) {
                  throw new Error('Invalid publish packetId')
                }
                packetId = body.readUInt16BE(payloadOffset)
                payloadOffset += 2
              }

              const payload = body.subarray(payloadOffset)
              const msg: MqttMessage = {
                topic,
                payload,
                qos,
                packetId,
                timestamp: Date.now(),
              }
              messages.push(msg)
              recordCall('PUBLISH')
              recordCall(`PUBLISH:${topic}`)

              const fault = faults.matchFault({
                topic,
                packetType: 3,
                method: 'PUBLISH',
              })
              if (fault) {
                if (fault.type === 'drop') {
                  socket.destroy()
                  return
                }
                if (fault.type === 'malformed') {
                  const bad = fault.payload ?? Buffer.from([0x40, 0x01, 0xff])
                  socket.write(Buffer.isBuffer(bad) ? bad : Buffer.from(bad))
                  socket.destroy()
                  return
                }
                if (fault.type === 'delay') {
                  await new Promise((r) => setTimeout(r, fault.delayMs))
                }
                if (fault.type === 'stall') {
                  return
                }
              }

              if (options.onPublish) {
                await options.onPublish(msg, socket)
              }

              if (qos === 1 && packetId !== undefined) {
                const idMsb = (packetId >> 8) & 0xff
                const idLsb = packetId & 0xff
                socket.write(Buffer.from([0x40, 0x02, idMsb, idLsb]))
              }

              // Relay to other subscribers
              for (const [subSock, topics] of subscriptions.entries()) {
                if (subSock === socket || !subSock.writable) continue
                let matched = false
                for (const filter of topics) {
                  if (matchMqttTopic(filter, topic)) {
                    matched = true
                    break
                  }
                }
                if (matched) {
                  subSock.write(encodePacket(header, body))
                }
              }
              continue
            }

            // 4. PINGREQ (packet type 12 = 0xc0)
            if (packetType === 12) {
              recordCall('PING')
              socket.write(Buffer.from([0xd0, 0x00]))
              continue
            }

            // 5. DISCONNECT (packet type 14 = 0xe0)
            if (packetType === 14) {
              recordCall('DISCONNECT')
              socket.end()
              return
            }

            throw new Error('Unsupported packet')
          }
        } catch {
          socket.destroy()
        }
      })
    },
  )

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to obtain MQTT broker listening address')
  }

  const port = addr.port
  const origin = `mqtts://${options.host ?? '127.0.0.1'}:${port}`

  const ports = Object.assign([port], {
    default: port,
    mqtt: port,
  }) as { default: number; mqtt: number } & number[]

  const callsFn = () => ({ ...callCounts })
  Object.defineProperty(callsFn, 'all', {
    get: () => messages,
  })

  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      scenario.stop()
      for (const timer of pendingTimers) {
        clearTimeout(timer)
      }
      pendingTimers.clear()

      const closed = new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      await disconnectClients()
      subscriptions.clear()
      await closed

      if (ownedTlsMaterial) {
        ownedTlsMaterial.cleanup()
        ownedTlsMaterial = undefined
      }
    })()
    return closing
  }

  return {
    origin,
    ports,
    control: {
      faults,
      scenario,
      publish: publishToSubscribers,
      disconnectClients,
      subscriptions,
      sockets,
      tlsMaterial: activeTlsMaterial,
    },
    calls: callsFn as any,
    close,
  }
}
