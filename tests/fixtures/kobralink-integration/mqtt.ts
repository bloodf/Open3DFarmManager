// SPDX-License-Identifier: MIT
// Original bounded MQTT 3.1.1 synthetic Kobra X responder. It answers the
// read-only queries an unmodified bridge issues and refuses everything else.
// No actuator support, no manufacturer keys, no firmware qualification.
import { EventEmitter } from 'node:events'
import { isIP, type Socket } from 'node:net'
import { createServer, type TLSSocket } from 'node:tls'
import {
  mqttField,
  mqttPacket,
  mqttPublish,
  mqttReader,
  takeMqttPackets,
  type MqttPacket,
} from './mqtt-wire.ts'
import type { SyntheticTls } from './tls.ts'

export const SYNTHETIC_OWNED_NETWORK_ENV = 'OPENFARM_SYNTHETIC_KOBRA_NETWORK'
export const SYNTHETIC_OWNED_NETWORK_VALUE = 'owned-isolated'

const TOPIC_ROOT = 'anycubic/anycubicCloud/v1'
const SYNTHETIC_MARK = 'SYNTHETIC'
const REFUSAL_LOG_LIMIT = 32
const WRITE_BACKLOG_LIMIT = 64 * 1024
const MAX_IDLE_MS = 120_000

export interface SyntheticMqttIdentity {
  username: string
  password: string
  deviceId: string
  modeId: string
}

export interface SyntheticTemperature {
  curr_nozzle_temp: number
  target_nozzle_temp: number
  curr_hotbed_temp: number
  target_hotbed_temp: number
}

export interface SyntheticProject {
  filename: string
  progress: number
  print_time: number
  remain_time: number
  curr_layer: number
  total_layers: number
  taskid: string
}

export interface SyntheticTelemetry {
  printerName: string
  version: string
  state: string
  temp: SyntheticTemperature
  fan_speed_pct: number
  print_speed_mode: number
  project: SyntheticProject | null
}

export interface SyntheticMqttOptions {
  identity: SyntheticMqttIdentity
  maxClients?: number
  maxPacketBytes?: number
  handshakeTimeoutMs?: number
  idleTimeoutMs?: number
  now?: () => number
}

export interface SyntheticRefusal {
  kind: 'slicer' | 'web'
  type: string
  action: string
}

export interface SyntheticMqttSnapshot {
  listening: boolean
  sessions: number
  subscribed: number
  accepted: number
  queries: number
  closed: Record<string, number>
  refused: SyntheticRefusal[]
}

interface Session {
  connected: boolean
  subscribed: boolean
  pending: Buffer
}

interface KobraRequest {
  type: string
  action: string
  msgid: string
}

export const SYNTHETIC_TELEMETRY: SyntheticTelemetry = Object.freeze({
  printerName: 'SYNTHETIC Kobra X (not firmware qualification)',
  version: 'SYNTHETIC-0.0.0',
  state: 'free',
  temp: Object.freeze({
    curr_nozzle_temp: 25,
    target_nozzle_temp: 0,
    curr_hotbed_temp: 24,
    target_hotbed_temp: 0,
  }),
  fan_speed_pct: 0,
  print_speed_mode: 1,
  project: null,
})

function assertSynthetic(telemetry: SyntheticTelemetry): void {
  for (const value of [telemetry.printerName, telemetry.version]) {
    if (!value.includes(SYNTHETIC_MARK)) {
      throw new Error(`Synthetic telemetry must be marked ${SYNTHETIC_MARK}`)
    }
  }
}

function isLoopback(host: string): boolean {
  return host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
}

function parseRequest(type: string, payload: Buffer): KobraRequest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { type: bodyType, action, msgid } = parsed as Record<string, unknown>
  if (bodyType !== type) return null
  if (typeof action !== 'string' || !/^[A-Za-z_]{1,64}$/.test(action)) {
    return null
  }
  if (typeof msgid !== 'string' || !/^[\w-]{1,64}$/.test(msgid)) return null
  return { type, action, msgid }
}

export function createSyntheticMqtt(
  tls: SyntheticTls,
  options: SyntheticMqttOptions,
) {
  const { identity } = options
  const maxClients = options.maxClients ?? 4
  const maxPacketBytes = options.maxPacketBytes ?? 4096
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 3000
  const now = options.now ?? Date.now
  const device = `${identity.modeId}/${identity.deviceId}`
  const subscribeFilter = `${TOPIC_ROOT}/printer/public/${device}/#`
  const requestPrefixes = {
    slicer: `${TOPIC_ROOT}/slicer/printer/${device}/`,
    web: `${TOPIC_ROOT}/web/printer/${device}/`,
  } as const

  const sessions = new Map<TLSSocket, Session>()
  const rawSockets = new Set<Socket>()
  const changes = new EventEmitter()
  let telemetry: SyntheticTelemetry = structuredClone(SYNTHETIC_TELEMETRY)
  let accepted = 0
  let queries = 0
  let pushes = 0
  let closed: Record<string, number> = {}
  let refused: SyntheticRefusal[] = []

  const reject = (socket: Socket, reason: string): void => {
    closed = { ...closed, [reason]: (closed[reason] ?? 0) + 1 }
    socket.destroy()
  }

  const send = (socket: TLSSocket, bytes: Buffer): void => {
    if (socket.destroyed) return
    if (socket.writableLength > WRITE_BACKLOG_LIMIT) {
      reject(socket, 'backpressure')
      return
    }
    socket.write(bytes)
  }

  const report = (
    type: string,
    action: string,
    msgid: string,
    state: string,
    data: unknown,
    failure?: string,
  ): void => {
    const body = JSON.stringify({
      type,
      action,
      msgid,
      timestamp: now(),
      state,
      code: failure === undefined ? 200 : 405,
      msg: failure ?? 'done',
      data,
    })
    const bytes = mqttPublish(
      `${TOPIC_ROOT}/printer/public/${device}/${type}/report`,
      body,
    )
    for (const [socket, session] of sessions) {
      if (session.subscribed) send(socket, bytes)
    }
  }

  const infoData = (): Record<string, unknown> => {
    const { project, ...info } = structuredClone(telemetry)
    return project === null ? info : { ...info, project }
  }

  const printData = (): Record<string, unknown> =>
    telemetry.project === null
      ? {}
      : {
          ...telemetry.project,
          settings: { print_speed_mode: telemetry.print_speed_mode },
        }

  /** Read-only queries only. Returns false for anything else. */
  const answerQuery = (request: KobraRequest): boolean => {
    const { type, action, msgid } = request
    const key = `${type}/${action}`
    if (key === 'info/query') {
      report(type, action, msgid, 'done', infoData())
    } else if (key === 'status/query') {
      report(type, action, msgid, 'done', { state: telemetry.state })
    } else if (key === 'print/query') {
      report(type, action, msgid, telemetry.state, printData())
    } else if (key === 'multiColorBox/getInfo') {
      report(type, action, msgid, 'done', { multi_color_box: [] })
    } else {
      return false
    }
    queries += 1
    return true
  }

  const publishStatus = (): void => {
    pushes += 1
    const msgid = `synthetic-push-${pushes}`
    report('info', 'report', msgid, 'done', infoData())
    report('tempature', 'report', msgid, 'done', { ...telemetry.temp })
    if (telemetry.project !== null) {
      report('print', 'report', msgid, telemetry.state, printData())
    }
  }

  const onConnect = (socket: TLSSocket, session: Session, body: Buffer) => {
    const reader = mqttReader(body)
    const name = reader.field()
    const level = reader.byte()
    const flags = reader.byte()
    const keepalive = reader.uint16()
    const clientId = reader.field()
    if (
      name?.toString('latin1') !== 'MQTT' ||
      level === undefined ||
      flags === undefined ||
      keepalive === undefined ||
      clientId === undefined ||
      (flags & 0x01) !== 0 ||
      (flags & 0x04) !== 0
    ) {
      reject(socket, 'malformed-connect')
      return
    }
    const username = (flags & 0x80) !== 0 ? reader.field() : null
    const password = (flags & 0x40) !== 0 ? reader.field() : null
    if (username === undefined || password === undefined || reader.remaining) {
      reject(socket, 'malformed-connect')
      return
    }
    const refuse = (code: number, reason: string): void => {
      closed = { ...closed, [reason]: (closed[reason] ?? 0) + 1 }
      socket.end(Buffer.from([0x20, 2, 0, code]))
    }
    if (level !== 4) return refuse(1, 'unsupported-protocol-level')
    if (clientId.length < 1 || clientId.length > 64) {
      return refuse(2, 'client-id-rejected')
    }
    if (
      username?.toString('utf8') !== identity.username ||
      password?.toString('utf8') !== identity.password
    ) {
      return refuse(4, 'bad-credentials')
    }
    session.connected = true
    accepted += 1
    const idle =
      options.idleTimeoutMs ??
      Math.min(MAX_IDLE_MS, keepalive > 0 ? keepalive * 1500 : MAX_IDLE_MS)
    socket.setTimeout(idle)
    send(socket, Buffer.from([0x20, 2, 0, 0]))
  }

  const onSubscribe = (socket: TLSSocket, session: Session, body: Buffer) => {
    const reader = mqttReader(body)
    const id = reader.uint16()
    const granted: number[] = []
    while (id !== undefined && reader.remaining > 0) {
      const filter = reader.field()
      const qos = reader.byte()
      if (filter === undefined || !filter.length || qos === undefined) break
      if (qos > 2) break
      granted.push(filter.toString('utf8') === subscribeFilter ? 0 : 0x80)
    }
    if (id === undefined || !granted.length || reader.remaining > 0) {
      reject(socket, 'malformed-subscribe')
      return
    }
    if (granted.includes(0)) session.subscribed = true
    send(
      socket,
      mqttPacket(0x90, Buffer.from([id >> 8, id & 0xff, ...granted])),
    )
  }

  const onUnsubscribe = (socket: TLSSocket, session: Session, body: Buffer) => {
    const reader = mqttReader(body)
    const id = reader.uint16()
    let count = 0
    while (id !== undefined && reader.remaining > 0) {
      const filter = reader.field()
      if (filter === undefined || !filter.length) break
      if (filter.toString('utf8') === subscribeFilter) {
        session.subscribed = false
      }
      count += 1
    }
    if (id === undefined || !count || reader.remaining > 0) {
      reject(socket, 'malformed-unsubscribe')
      return
    }
    send(socket, mqttPacket(0xb0, Buffer.from([id >> 8, id & 0xff])))
  }

  const onPublish = (socket: TLSSocket, header: number, body: Buffer) => {
    if ((header & 0x06) !== 0) {
      reject(socket, 'unsupported-qos')
      return
    }
    const reader = mqttReader(body)
    const topic = reader.field()?.toString('utf8')
    const kind = (['slicer', 'web'] as const).find((candidate) =>
      topic?.startsWith(requestPrefixes[candidate]),
    )
    if (topic === undefined || kind === undefined) {
      reject(socket, 'foreign-topic')
      return
    }
    const type = topic.slice(requestPrefixes[kind].length)
    const request = /^[A-Za-z]{1,32}$/.test(type)
      ? parseRequest(type, reader.rest())
      : null
    if (request === null) {
      reject(socket, 'malformed-request')
      return
    }
    if (kind === 'slicer' && answerQuery(request)) return
    // Fail closed: state never changes and the caller gets an explicit refusal.
    refused = [...refused, { kind, type, action: request.action }].slice(
      -REFUSAL_LOG_LIMIT,
    )
    report(
      type,
      request.action,
      request.msgid,
      'failed',
      null,
      'synthetic fixture refuses actuator and unsupported requests',
    )
  }

  const onPacket = (
    socket: TLSSocket,
    session: Session,
    packet: MqttPacket,
  ) => {
    const { header, body } = packet
    if (!session.connected) {
      if (header === 0x10) onConnect(socket, session, body)
      else reject(socket, 'connect-required')
    } else if (header === 0x82) {
      onSubscribe(socket, session, body)
    } else if (header === 0xa2) {
      onUnsubscribe(socket, session, body)
    } else if (header >> 4 === 3) {
      onPublish(socket, header, body)
    } else if (header === 0xc0 && !body.length) {
      send(socket, Buffer.from([0xd0, 0]))
    } else if (header === 0xe0 && !body.length) {
      socket.end()
    } else {
      reject(socket, 'unsupported-packet')
    }
  }

  const server = createServer(
    { key: tls.key, cert: tls.cert, handshakeTimeout: handshakeTimeoutMs },
    (socket: TLSSocket) => {
      if (sessions.size >= maxClients) {
        reject(socket, 'too-many-clients')
        return
      }
      const session: Session = {
        connected: false,
        subscribed: false,
        pending: Buffer.alloc(0),
      }
      sessions.set(socket, session)
      changes.emit('change')
      socket.setNoDelay(true)
      socket.setTimeout(handshakeTimeoutMs)
      socket.on('timeout', () => reject(socket, 'deadline'))
      socket.on('error', () => socket.destroy())
      socket.on('close', () => {
        sessions.delete(socket)
        changes.emit('change')
      })
      socket.on('data', (chunk: Buffer) => {
        const frames = takeMqttPackets(
          Buffer.concat([session.pending, chunk]),
          maxPacketBytes,
        )
        session.pending = Buffer.from(frames.rest)
        for (const packet of frames.packets) {
          if (socket.destroyed || socket.writableEnded) return
          onPacket(socket, session, packet)
        }
        if (frames.error !== undefined && !socket.destroyed) {
          reject(socket, frames.error)
        }
      })
    },
  )
  server.maxConnections = maxClients * 2
  server.on('connection', (socket: Socket) => {
    rawSockets.add(socket)
    socket.on('close', () => rawSockets.delete(socket))
  })
  server.on('tlsClientError', (_error: Error, socket: TLSSocket) => {
    reject(socket, 'tls-handshake')
  })

  return {
    server,
    identity,
    subscribeFilter,
    /** Binds loopback by default; any other address needs explicit opt-in. */
    async start(
      listen: { port?: number; host?: string } = {},
    ): Promise<{ host: string; port: number }> {
      const { port = 0, host = '127.0.0.1' } = listen
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new RangeError('Synthetic MQTT port out of range')
      }
      if (isIP(host) === 0) {
        throw new Error('Synthetic MQTT host must be a literal IP address')
      }
      if (
        !isLoopback(host) &&
        process.env[SYNTHETIC_OWNED_NETWORK_ENV] !==
          SYNTHETIC_OWNED_NETWORK_VALUE
      ) {
        throw new Error(
          `Synthetic MQTT binds loopback only unless ${SYNTHETIC_OWNED_NETWORK_ENV}=${SYNTHETIC_OWNED_NETWORK_VALUE} marks an owned isolated network`,
        )
      }
      if (server.listening) throw new Error('Synthetic MQTT already started')
      await new Promise<void>((resolve, fail) => {
        const onError = (error: Error): void => fail(error)
        server.once('error', onError)
        server.listen(port, host, () => {
          server.off('error', onError)
          resolve()
        })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('Synthetic MQTT has no socket address')
      }
      return { host: address.address, port: address.port }
    },
    telemetry(): SyntheticTelemetry {
      return structuredClone(telemetry)
    },
    /** Replaces the given fields and pushes reports to every subscriber. */
    setTelemetry(patch: Partial<SyntheticTelemetry>): SyntheticTelemetry {
      const next = structuredClone({ ...telemetry, ...patch })
      assertSynthetic(next)
      telemetry = next
      publishStatus()
      return structuredClone(telemetry)
    },
    publishStatus,
    snapshot(): SyntheticMqttSnapshot {
      const live = [...sessions.values()]
      return {
        listening: server.listening,
        sessions: live.length,
        subscribed: live.filter((session) => session.subscribed).length,
        accepted,
        queries,
        closed: { ...closed },
        refused: refused.map((entry) => ({ ...entry })),
      }
    },
    /** Resolves once exactly `count` sessions remain, or rejects at deadline. */
    async whenSessions(count: number, deadlineMs = 2000): Promise<void> {
      if (sessions.size === count) return
      await new Promise<void>((resolve, fail) => {
        const check = (): void => {
          if (sessions.size !== count) return
          clearTimeout(timer)
          changes.off('change', check)
          resolve()
        }
        const timer = setTimeout(() => {
          changes.off('change', check)
          fail(new Error(`Synthetic MQTT session deadline (${sessions.size})`))
        }, deadlineMs)
        changes.on('change', check)
      })
    },
    /** Idempotent: drops every client and releases the listener. */
    async stop(): Promise<void> {
      const listening = server.listening
      const done = listening
        ? new Promise<void>((resolve, fail) => {
            server.close((error) => (error ? fail(error) : resolve()))
          })
        : Promise.resolve()
      for (const socket of sessions.keys()) socket.destroy()
      for (const socket of rawSockets) socket.destroy()
      await done
    },
  }
}

export type SyntheticMqtt = ReturnType<typeof createSyntheticMqtt>
