// SPDX-License-Identifier: MIT
// Loopback TCP forwarder with runtime-changeable faults. Each direction is an
// in-order delay queue, so latency, jitter, a bandwidth cap and a blackhole never
// reorder bytes; they only decide when the next chunk may be written.
import { createServer, connect, type Server, type Socket } from 'node:net'
import { once } from 'node:events'
import {
  jitteredDelay,
  LinkClock,
  type NetFaultConfig,
} from './fault-config.ts'
import { assertLoopbackTarget } from './loopback.ts'

/** Source is paused above this many queued bytes, as a full TCP window would. */
const HIGH_WATER = 64 * 1024

export type TcpForwarderStats = {
  connections: number
  resets: number
  bytesForwarded: number
  delayedByLoss: number
}

type Item = { due: number; data: Buffer | null }

class Direction {
  private readonly queue: Item[] = []
  private readonly clock = new LinkClock()
  private lastDue = 0
  private queued = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  private readonly source: Socket
  private readonly sink: Socket
  private readonly env: {
    config: () => Readonly<NetFaultConfig>
    random: () => number
    stats: TcpForwarderStats
  }

  constructor(
    source: Socket,
    sink: Socket,
    env: {
      config: () => Readonly<NetFaultConfig>
      random: () => number
      stats: TcpForwarderStats
    },
  ) {
    this.source = source
    this.sink = sink
    this.env = env
    source.on('data', (chunk: Buffer) => this.push(chunk))
    source.on('end', () => this.enqueue(null, 0))
  }

  private push(chunk: Buffer) {
    this.enqueue(chunk, chunk.length)
    if (this.queued > HIGH_WATER) this.source.pause()
  }

  private enqueue(data: Buffer | null, length: number) {
    const config = this.env.config()
    const now = performance.now()
    let delay = jitteredDelay(config, this.env.random)
    if (config.loss > 0 && this.env.random() < config.loss) {
      delay += config.retransmitMs
      this.env.stats.delayedByLoss++
    }
    const sent = this.clock.finish(now, length, config)
    // TCP is ordered: a later chunk never overtakes an earlier one.
    const due = Math.max(sent + delay, this.lastDue)
    this.lastDue = due
    this.queued += length
    this.queue.push({ due, data })
    this.wake()
  }

  /** Re-evaluate the queue after a config change or a due time arriving. */
  wake() {
    if (this.closed) return
    clearTimeout(this.timer)
    this.timer = undefined
    const config = this.env.config()
    if (config.blackhole) return
    const now = performance.now()
    while (this.queue.length) {
      const head = this.queue[0]!
      if (head.due > now) {
        this.timer = setTimeout(() => this.wake(), head.due - now + 1)
        return
      }
      this.queue.shift()
      if (head.data === null) {
        this.sink.end()
        continue
      }
      this.queued -= head.data.length
      this.env.stats.bytesForwarded += head.data.length
      if (!this.sink.destroyed) this.sink.write(head.data)
    }
    if (this.queued <= HIGH_WATER / 2 && !this.source.destroyed)
      this.source.resume()
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.queue.length = 0
  }
}

export type TcpForwarder = {
  readonly port: number
  readonly stats: Readonly<TcpForwarderStats>
  /** Re-run delivery after the shared config changed. */
  refresh(): void
  /** Reset every open connection (RST) without touching the listener. */
  resetConnections(): void
  close(): Promise<void>
}

export async function startTcpForwarder(input: {
  listenPort?: number
  targetPort: number
  targetHost?: string
  config: () => Readonly<NetFaultConfig>
  random: () => number
}): Promise<TcpForwarder> {
  const targetHost = input.targetHost ?? '127.0.0.1'
  assertLoopbackTarget(targetHost)
  const stats: TcpForwarderStats = {
    connections: 0,
    resets: 0,
    bytesForwarded: 0,
    delayedByLoss: 0,
  }
  let stopped: Promise<void> | undefined
  const pairs = new Set<{
    client: Socket
    upstream: Socket
    directions: Direction[]
  }>()
  const rst = (socket: Socket) => {
    if (socket.destroyed) return
    stats.resets++
    socket.resetAndDestroy()
  }
  const server: Server = createServer((client) => {
    if (input.config().reset) {
      rst(client)
      return
    }
    stats.connections++
    const upstream = connect({ host: targetHost, port: input.targetPort })
    const env = { config: input.config, random: input.random, stats }
    const entry = {
      client,
      upstream,
      directions: [
        new Direction(client, upstream, env),
        new Direction(upstream, client, env),
      ],
    }
    pairs.add(entry)
    const teardown = () => {
      for (const direction of entry.directions) direction.close()
      client.destroy()
      upstream.destroy()
      pairs.delete(entry)
    }
    client.on('error', teardown).on('close', teardown)
    upstream.on('error', teardown).on('close', teardown)
  })
  server.listen(input.listenPort ?? 0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP address')
  const forwarder: TcpForwarder = {
    port: address.port,
    stats,
    refresh() {
      for (const pair of pairs)
        for (const direction of pair.directions) direction.wake()
      if (input.config().reset) forwarder.resetConnections()
    },
    resetConnections() {
      for (const pair of [...pairs]) {
        for (const direction of pair.directions) direction.close()
        rst(pair.client)
        rst(pair.upstream)
        pairs.delete(pair)
      }
    },
    close() {
      // Idempotent: the owner and the proxy may both close the forwarder.
      stopped ??= (async () => {
        for (const pair of [...pairs]) {
          for (const direction of pair.directions) direction.close()
          pair.client.destroy()
          pair.upstream.destroy()
        }
        pairs.clear()
        await new Promise<void>((done) => server.close(() => done()))
      })()
      return stopped
    },
  }
  return forwarder
}
