// SPDX-License-Identifier: MIT
// Loopback UDP forwarder. One upstream socket per client address keeps replies
// routable, so a peer that only knows the proxy port can hold a full ICE/DTLS/
// SCTP exchange with its real peer. Datagrams may be delayed, reordered by
// jitter, dropped (loss, blackhole, udpBlock) or tail-dropped by the bandwidth
// cap, like a netem queue.
import { createSocket, type Socket, type RemoteInfo } from 'node:dgram'
import { once } from 'node:events'
import {
  jitteredDelay,
  LinkClock,
  type NetFaultConfig,
} from './fault-config.ts'
import { assertLoopbackTarget } from './loopback.ts'

/** A datagram that would wait longer than this behind the rate cap is dropped. */
const MAX_QUEUE_MS = 500
/** An idle client session is released after this long. */
const SESSION_IDLE_MS = 30_000

export type UdpForwarderStats = {
  sessions: number
  forwarded: number
  droppedByLoss: number
  droppedByBlock: number
  droppedByRate: number
}

type Session = {
  upstream: Socket
  toTarget: LinkClock
  toClient: LinkClock
  idle: ReturnType<typeof setTimeout>
}

export type UdpForwarder = {
  readonly port: number
  readonly stats: Readonly<UdpForwarderStats>
  close(): Promise<void>
}

export async function startUdpForwarder(input: {
  listenPort?: number
  targetPort: number
  targetHost?: string
  config: () => Readonly<NetFaultConfig>
  random: () => number
}): Promise<UdpForwarder> {
  const targetHost = input.targetHost ?? '127.0.0.1'
  assertLoopbackTarget(targetHost)
  const stats: UdpForwarderStats = {
    sessions: 0,
    forwarded: 0,
    droppedByLoss: 0,
    droppedByBlock: 0,
    droppedByRate: 0,
  }
  const sessions = new Map<string, Session>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let closed = false
  let stopped: Promise<void> | undefined
  const listener = createSocket('udp4')

  /** A session or the listener may close while a datagram is still in flight. */
  function send(socket: Socket, data: Buffer, port: number, address: string) {
    if (closed) return
    try {
      socket.send(data, port, address, () => {})
    } catch {
      // Socket already closed: the datagram is lost, as on a real link.
    }
  }

  /** Applies the fault pipeline; `deliver` runs once the datagram is due. */
  function shape(clock: LinkClock, size: number, deliver: () => void) {
    const config = input.config()
    if (config.blackhole || config.udpBlock) {
      stats.droppedByBlock++
      return
    }
    if (config.loss > 0 && input.random() < config.loss) {
      stats.droppedByLoss++
      return
    }
    const now = performance.now()
    if (clock.backlogMs(now) > MAX_QUEUE_MS) {
      stats.droppedByRate++
      return
    }
    const due =
      clock.finish(now, size, config) + jitteredDelay(config, input.random)
    const wait = Math.max(0, due - now)
    const timer = setTimeout(() => {
      timers.delete(timer)
      // A fault raised while the datagram was in flight still swallows it.
      const latest = input.config()
      if (closed) return
      if (latest.blackhole || latest.udpBlock) {
        stats.droppedByBlock++
        return
      }
      stats.forwarded++
      deliver()
    }, wait)
    timers.add(timer)
  }

  function sessionFor(client: RemoteInfo): Session {
    const key = `${client.address}:${client.port}`
    const existing = sessions.get(key)
    if (existing) {
      existing.idle.refresh()
      return existing
    }
    const upstream = createSocket('udp4')
    const session: Session = {
      upstream,
      toTarget: new LinkClock(),
      toClient: new LinkClock(),
      idle: setTimeout(() => release(key), SESSION_IDLE_MS),
    }
    session.idle.unref()
    upstream.on('error', () => release(key))
    upstream.on('message', (reply) => {
      shape(session.toClient, reply.length, () => {
        send(listener, reply, client.port, client.address)
      })
    })
    upstream.bind(0, '127.0.0.1')
    sessions.set(key, session)
    stats.sessions++
    return session
  }

  function release(key: string) {
    const session = sessions.get(key)
    if (!session) return
    sessions.delete(key)
    clearTimeout(session.idle)
    try {
      session.upstream.close()
    } catch {
      // Already closed.
    }
  }

  listener.on('error', () => {})
  listener.on('message', (message, client) => {
    if (closed) return
    const session = sessionFor(client)
    shape(session.toTarget, message.length, () =>
      send(session.upstream, message, input.targetPort, targetHost),
    )
  })
  listener.bind(input.listenPort ?? 0, '127.0.0.1')
  await once(listener, 'listening')
  // Default rmem holds about 221 skbs. A larger burst becomes an uncounted kernel drop.
  listener.setRecvBufferSize(1024 * 1024)
  return {
    port: listener.address().port,
    stats,
    close() {
      // Idempotent: the owner and the proxy may both close the forwarder.
      stopped ??= (async () => {
        closed = true
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        for (const key of [...sessions.keys()]) release(key)
        await new Promise<void>((done) => listener.close(() => done()))
      })()
      return stopped
    },
  }
}
