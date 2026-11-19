// SPDX-License-Identifier: MIT
// #356 [E16.9]: Docker-free network faults. Everything runs on loopback.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { resolve } from 'node:path'
import {
  createNetFaultProxy,
  CLEAN_FAULTS,
} from '../../infra/sim/netfault/fault-proxy.ts'
import {
  hostCandidatePorts,
  rewriteHostCandidates,
} from '../../infra/sim/netfault/sdp-rewrite.ts'
import {
  loadDatachannel,
  openProxiedChannel,
} from '../../infra/sim/netfault/rtc-loopback.ts'
import { getSimMode } from '../../packages/sim-tools/src/mocks/index.ts'

const root = resolve(import.meta.dirname, '../..')

async function echoServer() {
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.on('data', (chunk) => socket.write(chunk))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise((done) => server.close(done))
    },
  }
}

async function udpEcho() {
  const socket = createSocket('udp4')
  socket.on('message', (message, remote) =>
    socket.send(message, remote.port, remote.address),
  )
  socket.bind(0, '127.0.0.1')
  await once(socket, 'listening')
  return {
    port: socket.address().port,
    close: () => new Promise((done) => socket.close(done)),
  }
}

async function roundTripMs(port, payload = 'ping') {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  const started = performance.now()
  socket.write(payload)
  await once(socket, 'data')
  const elapsed = performance.now() - started
  socket.destroy()
  return elapsed
}

function udpProbe(port, timeoutMs) {
  return new Promise((done) => {
    const socket = createSocket('udp4')
    const timer = setTimeout(() => {
      socket.close()
      done(null)
    }, timeoutMs)
    socket.on('message', () => {
      clearTimeout(timer)
      socket.close()
      done(performance.now() - started)
    })
    const started = performance.now()
    socket.send('x', port, '127.0.0.1')
  })
}

test('default mode is mock and Docker stays opt-in', () => {
  const saved = process.env.OPENFARM_SIM
  try {
    delete process.env.OPENFARM_SIM
    assert.equal(getSimMode(), 'mock')
    process.env.OPENFARM_SIM = 'docker'
    assert.equal(getSimMode(), 'docker')
  } finally {
    if (saved === undefined) delete process.env.OPENFARM_SIM
    else process.env.OPENFARM_SIM = saved
  }
})

test('TCP latency applies per direction and can change while connected', async () => {
  const upstream = await echoServer()
  const proxy = createNetFaultProxy()
  const tcp = await proxy.forwardTcp({ targetPort: upstream.port })
  try {
    const socket = connect(tcp.port, '127.0.0.1')
    socket.on('error', () => {})
    await once(socket, 'connect')
    const exchange = async () => {
      const started = performance.now()
      socket.write('a')
      await once(socket, 'data')
      return performance.now() - started
    }
    assert.ok((await exchange()) < 100)
    proxy.set({ latencyMs: 120 })
    const slow = await exchange()
    assert.ok(slow >= 230 && slow < 600, `round trip ${slow}`)
    proxy.set({ latencyMs: 0 })
    assert.ok((await exchange()) < 100)
    socket.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('TCP bandwidth cap paces the stream and keeps every byte in order', async () => {
  const upstream = await echoServer()
  const proxy = createNetFaultProxy({
    faults: { bandwidthBytesPerSec: 20_000 },
  })
  const tcp = await proxy.forwardTcp({ targetPort: upstream.port })
  try {
    const socket = connect(tcp.port, '127.0.0.1')
    socket.on('error', () => {})
    await once(socket, 'connect')
    const payload = Buffer.alloc(10_000, 7)
    payload.writeUInt32BE(0xdeadbeef, 0)
    const chunks = []
    let received = 0
    const done = new Promise((resolveDone) =>
      socket.on('data', (chunk) => {
        chunks.push(chunk)
        received += chunk.length
        if (received >= payload.length * 1) resolveDone()
      }),
    )
    const started = performance.now()
    socket.write(payload)
    await done
    const elapsed = performance.now() - started
    // 10 kB each way at 20 kB/s: at least ~0.5 s per direction.
    assert.ok(elapsed >= 800, `elapsed ${elapsed}`)
    assert.ok(Buffer.concat(chunks).equals(payload))
    socket.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('TCP loss is hidden by retransmission delay and never corrupts data', async () => {
  const upstream = await echoServer()
  const proxy = createNetFaultProxy({
    faults: { loss: 1, retransmitMs: 150 },
    seed: 1,
  })
  const tcp = await proxy.forwardTcp({ targetPort: upstream.port })
  try {
    const elapsed = await roundTripMs(tcp.port)
    assert.ok(elapsed >= 280, `elapsed ${elapsed}`)
    assert.ok(tcp.stats.delayedByLoss >= 2)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('TCP reset kills open connections and refuses new ones until cleared', async () => {
  const upstream = await echoServer()
  const proxy = createNetFaultProxy()
  const tcp = await proxy.forwardTcp({ targetPort: upstream.port })
  try {
    const closes = (socket) => {
      socket.on('error', () => {})
      return new Promise((done) => socket.once('close', done))
    }
    const open = connect(tcp.port, '127.0.0.1')
    const openClosed = closes(open)
    await once(open, 'connect')
    proxy.set({ reset: true })
    await openClosed
    const refused = connect(tcp.port, '127.0.0.1')
    await closes(refused)
    assert.ok(tcp.stats.resets >= 2)
    proxy.set({ reset: false })
    assert.ok((await roundTripMs(tcp.port)) < 200)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('TCP blackhole holds data and delivers it when lifted', async () => {
  const upstream = await echoServer()
  const proxy = createNetFaultProxy()
  const tcp = await proxy.forwardTcp({ targetPort: upstream.port })
  try {
    const socket = connect(tcp.port, '127.0.0.1')
    socket.on('error', () => {})
    await once(socket, 'connect')
    proxy.set({ blackhole: true })
    let got = false
    socket.once('data', () => (got = true))
    socket.write('held')
    await new Promise((done) => setTimeout(done, 400))
    assert.equal(got, false)
    proxy.set({ blackhole: false })
    await once(socket, 'data')
    socket.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('UDP faults: latency, loss, blackhole and UDP-only block', async () => {
  const upstream = await udpEcho()
  const tcpUpstream = await echoServer()
  const proxy = createNetFaultProxy({ seed: 3 })
  const udp = await proxy.forwardUdp({ targetPort: upstream.port })
  const tcp = await proxy.forwardTcp({ targetPort: tcpUpstream.port })
  try {
    assert.ok((await udpProbe(udp.port, 1000)) < 100)
    proxy.set({ latencyMs: 100 })
    const slow = await udpProbe(udp.port, 2000)
    assert.ok(slow >= 190, `udp rtt ${slow}`)
    proxy.set({ latencyMs: 0, loss: 1 })
    assert.equal(await udpProbe(udp.port, 300), null)
    assert.ok(udp.stats.droppedByLoss >= 1)
    proxy.set({ loss: 0, blackhole: true })
    assert.equal(await udpProbe(udp.port, 300), null)
    proxy.set({ blackhole: false, udpBlock: true })
    assert.equal(await udpProbe(udp.port, 300), null)
    // TCP is untouched by a UDP-only block.
    assert.ok((await roundTripMs(tcp.port)) < 200)
    proxy.set({ udpBlock: false })
    assert.ok((await udpProbe(udp.port, 1000)) < 100)
    assert.ok(udp.stats.droppedByBlock >= 2)
  } finally {
    await proxy.close()
    await upstream.close()
    await tcpUpstream.close()
  }
})

test('UDP loss rate tracks the configured probability and is reproducible', async () => {
  const sink = createSocket('udp4')
  let received = 0
  sink.on('message', () => received++)
  sink.bind(0, '127.0.0.1')
  await once(sink, 'listening')
  const dropped = []
  for (let run = 0; run < 2; run++) {
    received = 0
    const proxy = createNetFaultProxy({ faults: { loss: 0.3 }, seed: 42 })
    const udp = await proxy.forwardUdp({ targetPort: sink.address().port })
    const client = createSocket('udp4')
    client.bind(0, '127.0.0.1')
    await once(client, 'listening')
    for (let i = 0; i < 400; i++) client.send('x', udp.port, '127.0.0.1')
    await new Promise((done) => setTimeout(done, 400))
    client.close()
    assert.equal(received + udp.stats.droppedByLoss, 400)
    dropped.push(udp.stats.droppedByLoss)
    await proxy.close()
  }
  sink.close()
  assert.equal(dropped[0], dropped[1], 'same seed, same drops')
  assert.ok(dropped[0] > 90 && dropped[0] < 150, `dropped ${dropped[0]} of 400`)
})

test('config validation rejects out-of-range values and non-loopback targets', async () => {
  const proxy = createNetFaultProxy()
  assert.throws(() => proxy.set({ loss: 1.5 }), RangeError)
  assert.throws(() => proxy.set({ latencyMs: -1 }), RangeError)
  assert.throws(() => proxy.set({ bandwidthBytesPerSec: 0 }), RangeError)
  assert.deepEqual(proxy.faults(), CLEAN_FAULTS)
  await assert.rejects(
    proxy.forwardTcp({ targetPort: 80, targetHost: '192.0.2.10' }),
    /loopback only/,
  )
  await assert.rejects(
    proxy.forwardUdp({ targetPort: 80, targetHost: 'example.com' }),
    /loopback only/,
  )
  await proxy.close()
})

test('SDP rewrite maps host candidates to proxy ports and drops unmapped ones', () => {
  const sdp = [
    'v=0',
    'a=candidate:1 1 UDP 2122317823 127.0.0.1 40001 typ host',
    'a=candidate:2 1 UDP 2122317823 10.0.0.9 40002 typ host',
    'a=end-of-candidates',
  ].join('\r\n')
  assert.deepEqual(hostCandidatePorts(sdp), [40001, 40002])
  const { sdp: out, rewritten } = rewriteHostCandidates(
    sdp,
    new Map([[40001, 50001]]),
  )
  assert.deepEqual(rewritten, [40001])
  assert.match(out, /127\.0\.0\.1 50001 typ host/)
  assert.doesNotMatch(out, /40002|10\.0\.0\.9/)
})

const rtc = (() => {
  try {
    return loadDatachannel()
  } catch (error) {
    return error
  }
})()
after(() => {
  if (!(rtc instanceof Error)) rtc.cleanup()
})

test('WebRTC data channel survives 5 % loss and 200 ms latency', async (t) => {
  assert.ok(!(rtc instanceof Error), `node-datachannel unavailable: ${rtc}`)
  const proxy = createNetFaultProxy({
    // 100 ms each way = 200 ms round trip; 5 % loss each way.
    faults: { latencyMs: 100, jitterMs: 10, loss: 0.05 },
    seed: 7,
  })
  const channel = await openProxiedChannel({ proxy, openTimeoutMs: 25_000 })
  try {
    assert.equal(await channel.opened, true, 'channel must open under faults')
    let echoed = 0
    const sent = 30
    const started = performance.now()
    for (let i = 0; i < sent; i++)
      if (await channel.echo(`m${i}`, 4000)) echoed++
    const rtt = (performance.now() - started) / sent
    t.diagnostic(`echoed ${echoed}/${sent}, mean echo ${Math.round(rtt)} ms`)
    // SCTP retransmits lost packets, so every message must come back.
    assert.equal(echoed, sent)
    assert.ok(rtt >= 190, `mean echo ${rtt} ms is below the 200 ms round trip`)
  } finally {
    await channel.close()
    await proxy.close()
  }
})

test('WebRTC data channel fails cleanly under UDP block and recovers once lifted', async () => {
  assert.ok(!(rtc instanceof Error), `node-datachannel unavailable: ${rtc}`)
  const proxy = createNetFaultProxy({ faults: { udpBlock: true } })
  const blocked = await openProxiedChannel({ proxy, openTimeoutMs: 6000 })
  try {
    assert.equal(await blocked.opened, false)
    assert.equal(blocked.isOpen(), false)
    assert.notEqual(blocked.iceState(), 'connected')
    assert.equal(await blocked.echo('nope', 300), false)
  } finally {
    await blocked.close()
  }
  proxy.set({ udpBlock: false })
  const clear = await openProxiedChannel({ proxy, openTimeoutMs: 10_000 })
  try {
    assert.equal(await clear.opened, true)
    assert.equal(await clear.echo('back', 3000), true)
    // A block raised mid-session stops traffic; lifting it lets SCTP resume.
    proxy.set({ udpBlock: true })
    assert.equal(await clear.echo('during', 1500), false)
    proxy.set({ udpBlock: false })
    assert.equal(await clear.echo('after', 10_000), true)
  } finally {
    await clear.close()
    await proxy.close()
  }
})

test('connector outage runner has a Docker-free mock mode and keeps Docker opt-in', () => {
  const runner = readFileSync(
    resolve(root, 'scripts/test-connector-outage-recovery.ts'),
    'utf8',
  )
  assert.match(runner, /getSimMode|isDockerSim/)
  assert.match(runner, /createNetFaultProxy/)
  const scenarios = readFileSync(
    resolve(root, 'tests/helpers/connector-outage-scenarios.ts'),
    'utf8',
  )
  assert.match(scenarios, /dbStall/)
})

test('opt-in Docker harness guard still passes', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-force-exit',
      resolve(root, 'tests/node/sim-netfault-harness.test.ts'),
    ],
    { encoding: 'utf8', cwd: root },
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
