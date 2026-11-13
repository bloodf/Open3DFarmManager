// SPDX-License-Identifier: MIT
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import {
  createSyntheticMqtt,
  SYNTHETIC_OWNED_NETWORK_ENV,
  type SyntheticMqtt,
  type SyntheticMqttOptions,
} from '../fixtures/kobralink-integration/mqtt.ts'
import {
  mqttField,
  mqttPacket,
  mqttPublish,
  mqttReader,
  takeMqttPackets,
  type MqttPacket,
} from '../fixtures/kobralink-integration/mqtt-wire.ts'
import {
  createSyntheticTls,
  type SyntheticTls,
} from '../fixtures/kobralink-integration/tls.ts'

const DEADLINE_MS = 3000
const identity = {
  username: 'synthetic-only',
  password: 'synthetic-fixture-password-not-a-secret',
  deviceId: 'OPENFARM_SYNTHETIC_KOBRA_X_001',
  modeId: '20030',
}
const device = `${identity.modeId}/${identity.deviceId}`
const publicTopic = `anycubic/anycubicCloud/v1/printer/public/${device}`
const slicerTopic = `anycubic/anycubicCloud/v1/slicer/printer/${device}`
const webTopic = `anycubic/anycubicCloud/v1/web/printer/${device}`
const subscribeBytes = mqttPacket(
  0x82,
  Buffer.concat([
    Buffer.from([0, 7]),
    mqttField(`${publicTopic}/#`),
    Buffer.from([0]),
  ]),
)

let tls: SyntheticTls
before(() => {
  tls = createSyntheticTls()
})

function connectBytes(
  overrides: { level?: number; username?: string; password?: string } = {},
): Buffer {
  return mqttPacket(
    0x10,
    Buffer.concat([
      mqttField('MQTT'),
      Buffer.from([overrides.level ?? 4, 0xc2, 0, 60]),
      mqttField('kobrax_node'),
      mqttField(overrides.username ?? identity.username),
      mqttField(overrides.password ?? identity.password),
    ]),
  )
}

function request(
  type: string,
  action: string,
  msgid: string,
  data: unknown = null,
  root = slicerTopic,
): Buffer {
  return mqttPublish(
    `${root}/${type}`,
    JSON.stringify({ type, action, msgid, timestamp: 1, data }),
  )
}

/** Real socket wrapper that reassembles complete packets under a deadline. */
function wrap(socket: Socket) {
  const queue: MqttPacket[] = []
  let pending = Buffer.alloc(0)
  let wake: (() => void) | null = null
  let ended = false
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      ended = true
      wake?.()
      resolve()
    })
  })
  socket.on('error', () => {})
  socket.on('data', (chunk: Buffer) => {
    const frames = takeMqttPackets(Buffer.concat([pending, chunk]), 1 << 20)
    assert.equal(frames.error, undefined)
    pending = Buffer.from(frames.rest)
    queue.push(...frames.packets)
    wake?.()
  })
  const deadline = <T>(work: Promise<T>, label: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined
    return Promise.race([
      work,
      new Promise<never>((_resolve, fail) => {
        timer = setTimeout(
          () => fail(new Error(`${label} deadline`)),
          DEADLINE_MS,
        )
      }),
    ]).finally(() => clearTimeout(timer))
  }
  const next = async (): Promise<MqttPacket> => {
    while (!queue.length) {
      if (ended) throw new Error('socket closed before a packet arrived')
      await deadline(
        new Promise<void>((resolve) => {
          wake = resolve
        }),
        'packet',
      )
      wake = null
    }
    return queue.shift() as MqttPacket
  }
  return {
    socket,
    next,
    write: (bytes: Buffer) => socket.write(bytes),
    async report(): Promise<{
      topic: string
      body: Record<string, unknown>
    }> {
      const packet = await next()
      assert.equal(packet.header, 0x30)
      const reader = mqttReader(packet.body)
      const topic = reader.field()
      assert.ok(topic)
      return {
        topic: topic.toString('utf8'),
        body: JSON.parse(reader.rest().toString('utf8')),
      }
    },
    /** Resolves only when the peer closes; no packet may arrive first. */
    async closedByPeer(): Promise<void> {
      await deadline(closed, 'close')
      assert.deepEqual(queue, [])
    },
    async close(): Promise<void> {
      socket.destroy()
      await deadline(closed, 'close')
    },
  }
}

async function open(port: number) {
  // Pinned to the fresh synthetic certificate; its name is not a real host.
  const insecure = connectTls({
    port,
    host: '127.0.0.1',
    ca: tls.cert,
    checkServerIdentity: () => undefined,
  })
  const client = wrap(insecure)
  await new Promise<void>((resolve, fail) => {
    insecure.once('secureConnect', resolve)
    insecure.once('error', fail)
  })
  return client
}

async function session(port: number) {
  const client = await open(port)
  client.write(connectBytes())
  assert.deepEqual(await client.next(), {
    header: 0x20,
    body: Buffer.from([0, 0]),
  })
  client.write(subscribeBytes)
  assert.deepEqual(await client.next(), {
    header: 0x90,
    body: Buffer.from([0, 7, 0]),
  })
  return client
}

async function withFixture(
  work: (fixture: SyntheticMqtt, port: number) => Promise<void>,
  options: Partial<SyntheticMqttOptions> = {},
): Promise<void> {
  const fixture = createSyntheticMqtt(tls, { identity, ...options })
  const { port, host } = await fixture.start()
  assert.equal(host, '127.0.0.1')
  try {
    await work(fixture, port)
  } finally {
    await fixture.stop()
  }
  assert.equal(fixture.snapshot().listening, false)
}

test('fragmented handshake, subscription and read-only queries', async () => {
  await withFixture(async (fixture, port) => {
    const client = await open(port)
    const hello = connectBytes()
    // One byte at a time, then a split tail: packets never align to writes.
    for (const byte of hello.subarray(0, 6)) client.write(Buffer.from([byte]))
    client.write(hello.subarray(6, 20))
    client.write(hello.subarray(20))
    assert.deepEqual(await client.next(), {
      header: 0x20,
      body: Buffer.from([0, 0]),
    })
    // Two packets coalesced into one write.
    client.write(Buffer.concat([subscribeBytes, Buffer.from([0xc0, 0])]))
    assert.deepEqual(await client.next(), {
      header: 0x90,
      body: Buffer.from([0, 7, 0]),
    })
    assert.deepEqual(await client.next(), {
      header: 0xd0,
      body: Buffer.alloc(0),
    })

    client.write(request('info', 'query', 'msg-info'))
    const info = await client.report()
    assert.equal(info.topic, `${publicTopic}/info/report`)
    assert.deepEqual(
      { ...info.body, timestamp: 0 },
      {
        type: 'info',
        action: 'query',
        msgid: 'msg-info',
        timestamp: 0,
        state: 'done',
        code: 200,
        msg: 'done',
        data: {
          printerName: 'SYNTHETIC Kobra X (not firmware qualification)',
          version: 'SYNTHETIC-0.0.0',
          state: 'free',
          temp: {
            curr_nozzle_temp: 25,
            target_nozzle_temp: 0,
            curr_hotbed_temp: 24,
            target_hotbed_temp: 0,
          },
          fan_speed_pct: 0,
          print_speed_mode: 1,
        },
      },
    )

    client.write(request('multiColorBox', 'getInfo', 'msg-box'))
    const box = await client.report()
    assert.equal(box.topic, `${publicTopic}/multiColorBox/report`)
    assert.equal(box.body.msgid, 'msg-box')
    assert.deepEqual(box.body.data, { multi_color_box: [] })

    client.write(request('status', 'query', 'msg-status'))
    const status = await client.report()
    assert.equal(status.topic, `${publicTopic}/status/report`)
    assert.deepEqual(status.body.data, { state: 'free' })

    client.write(request('print', 'query', 'msg-print'))
    const print = await client.report()
    assert.equal(print.topic, `${publicTopic}/print/report`)
    assert.equal(print.body.state, 'free')
    assert.deepEqual(print.body.data, {})

    const snapshot = fixture.snapshot()
    assert.equal(snapshot.accepted, 1)
    assert.equal(snapshot.subscribed, 1)
    assert.equal(snapshot.queries, 4)
    assert.deepEqual(snapshot.refused, [])
    await client.close()
  })
})

test('telemetry state is published to subscribers only', async () => {
  await withFixture(
    async (fixture, port) => {
      const subscriber = await session(port)
      const silent = await open(port)
      silent.write(connectBytes())
      assert.equal((await silent.next()).header, 0x20)

      const project = {
        filename: 'synthetic-cube.gcode',
        progress: 42,
        print_time: 10,
        remain_time: 14,
        curr_layer: 21,
        total_layers: 50,
        taskid: 'synthetic-task-1',
      }
      const next = fixture.setTelemetry({
        state: 'printing',
        temp: {
          curr_nozzle_temp: 210,
          target_nozzle_temp: 215,
          curr_hotbed_temp: 59,
          target_hotbed_temp: 60,
        },
        project,
      })
      assert.deepEqual(fixture.telemetry(), next)

      const info = await subscriber.report()
      assert.equal(info.topic, `${publicTopic}/info/report`)
      assert.equal(info.body.msgid, 'synthetic-push-1')
      assert.equal(info.body.timestamp, 1_700_000_000_000)
      const data = info.body.data as Record<string, unknown>
      assert.equal(data.state, 'printing')
      assert.deepEqual(data.project, project)
      assert.match(String(data.printerName), /SYNTHETIC/)
      assert.match(String(data.version), /SYNTHETIC/)

      const temp = await subscriber.report()
      assert.equal(temp.topic, `${publicTopic}/tempature/report`)
      assert.deepEqual(temp.body.data, next.temp)

      const print = await subscriber.report()
      assert.equal(print.topic, `${publicTopic}/print/report`)
      assert.equal(print.body.state, 'printing')
      assert.deepEqual(print.body.data, {
        ...project,
        settings: { print_speed_mode: 1 },
      })

      // Returned state is a copy: mutating it cannot reach the fixture.
      next.temp.curr_nozzle_temp = 999
      assert.equal(fixture.telemetry().temp.curr_nozzle_temp, 210)
      assert.throws(
        () => fixture.setTelemetry({ printerName: 'Kobra X' }),
        /SYNTHETIC/,
      )
      assert.throws(() => fixture.setTelemetry({ version: '3.1.0' }))
      assert.equal(fixture.telemetry().version, 'SYNTHETIC-0.0.0')

      // The unsubscribed session saw nothing; a ping is its next packet.
      silent.write(Buffer.from([0xc0, 0]))
      assert.equal((await silent.next()).header, 0xd0)
      await subscriber.close()
      await silent.close()
    },
    { now: () => 1_700_000_000_000 },
  )
})

test('disconnect and reconnect start clean sessions', async () => {
  await withFixture(async (fixture, port) => {
    const first = await session(port)
    first.write(Buffer.from([0xe0, 0]))
    await first.closedByPeer()
    await fixture.whenSessions(0, DEADLINE_MS)

    const abrupt = await session(port)
    await abrupt.close()
    await fixture.whenSessions(0, DEADLINE_MS)

    const again = await open(port)
    again.write(connectBytes())
    assert.equal((await again.next()).header, 0x20)
    // Subscriptions do not survive a reconnect: no report without SUBSCRIBE.
    again.write(request('info', 'query', 'msg-before'))
    again.write(subscribeBytes)
    assert.equal((await again.next()).header, 0x90)
    again.write(request('info', 'query', 'msg-after'))
    assert.equal((await again.report()).body.msgid, 'msg-after')

    // UNSUBSCRIBE is acknowledged and silences later reports.
    again.write(
      mqttPacket(
        0xa2,
        Buffer.concat([Buffer.from([0, 9]), mqttField(`${publicTopic}/#`)]),
      ),
    )
    assert.deepEqual(await again.next(), {
      header: 0xb0,
      body: Buffer.from([0, 9]),
    })
    again.write(request('info', 'query', 'msg-silent'))
    again.write(Buffer.from([0xc0, 0]))
    assert.equal((await again.next()).header, 0xd0)

    const snapshot = fixture.snapshot()
    assert.equal(snapshot.accepted, 3)
    assert.equal(snapshot.sessions, 1)
    assert.equal(snapshot.subscribed, 0)
    assert.equal(snapshot.queries, 3)
    await again.close()
  })
})

test('credentials and protocol level are enforced', async () => {
  await withFixture(async (fixture, port) => {
    for (const [overrides, code] of [
      [{ password: 'wrong' }, 4],
      [{ username: 'someone-else' }, 4],
      [{ level: 5 }, 1],
    ] as const) {
      const client = await open(port)
      client.write(connectBytes(overrides))
      assert.deepEqual(await client.next(), {
        header: 0x20,
        body: Buffer.from([0, code]),
      })
      await client.closedByPeer()
    }
    const snapshot = fixture.snapshot()
    assert.equal(snapshot.accepted, 0)
    assert.deepEqual(snapshot.closed, {
      'bad-credentials': 2,
      'unsupported-protocol-level': 1,
    })
  })
})

test('command packets fail closed without changing state', async () => {
  await withFixture(async (fixture, port) => {
    const client = await session(port)
    const before = fixture.telemetry()
    const commands = [
      ['print', 'start', slicerTopic],
      ['print', 'pause', slicerTopic],
      ['print', 'resume', slicerTopic],
      ['print', 'stop', slicerTopic],
      ['fan', 'setSpeed', slicerTopic],
      ['light', 'control', slicerTopic],
      ['axis', 'move', slicerTopic],
      ['axis', 'turnOff', slicerTopic],
      ['video', 'startCapture', slicerTopic],
      ['file', 'deleteBatch', slicerTopic],
      ['file', 'listLocal', slicerTopic],
      ['skip', 'start', slicerTopic],
      ['multiColorBox', 'feedFilament', slicerTopic],
      ['multiColorBox', 'setDry', slicerTopic],
      ['tempature', 'set', webTopic],
      ['print', 'update', webTopic],
      ['info', 'query', webTopic],
    ] as const
    for (const [index, [type, action, root]] of commands.entries()) {
      const msgid = `msg-command-${index}`
      client.write(request(type, action, msgid, { taskid: '-1' }, root))
      const refusal = await client.report()
      assert.equal(refusal.topic, `${publicTopic}/${type}/report`)
      assert.deepEqual(
        { ...refusal.body, timestamp: 0 },
        {
          type,
          action,
          msgid,
          timestamp: 0,
          state: 'failed',
          code: 405,
          msg: 'synthetic fixture refuses actuator and unsupported requests',
          data: null,
        },
      )
    }
    const snapshot = fixture.snapshot()
    assert.equal(snapshot.queries, 0)
    assert.deepEqual(
      snapshot.refused,
      commands.map(([type, action, root]) => ({
        kind: root === webTopic ? 'web' : 'slicer',
        type,
        action,
      })),
    )
    assert.deepEqual(fixture.telemetry(), before)
    await client.close()
  })
})

test('malformed and oversize input closes only the offending socket', async () => {
  await withFixture(
    async (fixture, port) => {
      const healthy = await session(port)
      const json = (value: unknown): Buffer =>
        Buffer.from(JSON.stringify(value))
      const afterConnect: [string, Buffer, string][] = [
        ['second CONNECT', connectBytes(), 'unsupported-packet'],
        ['PUBREL', Buffer.from([0x62, 2, 0, 1]), 'unsupported-packet'],
        ['PINGREQ with body', Buffer.from([0xc0, 1, 0]), 'unsupported-packet'],
        [
          'SUBSCRIBE bad flags',
          Buffer.from([0x80, 2, 0, 1]),
          'unsupported-packet',
        ],
        [
          'SUBSCRIBE no filter',
          Buffer.from([0x82, 2, 0, 1]),
          'malformed-subscribe',
        ],
        [
          'SUBSCRIBE truncated filter',
          Buffer.from([0x82, 5, 0, 1, 0, 9, 0x61]),
          'malformed-subscribe',
        ],
        [
          'SUBSCRIBE bad QoS',
          Buffer.from([0x82, 6, 0, 1, 0, 1, 0x61, 3]),
          'malformed-subscribe',
        ],
        [
          'UNSUBSCRIBE empty',
          Buffer.from([0xa2, 2, 0, 1]),
          'malformed-unsubscribe',
        ],
        [
          'five byte length',
          Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]),
          'malformed',
        ],
        // Declares one megabyte; rejected before any body byte is sent.
        ['oversize length', Buffer.from([0x30, 0x80, 0x80, 0x40]), 'oversize'],
        [
          'oversize packet',
          mqttPublish(`${slicerTopic}/info`, Buffer.alloc(600, 0x61)),
          'oversize',
        ],
        [
          'QoS 1 publish',
          mqttPacket(
            0x32,
            Buffer.concat([mqttField(`${slicerTopic}/info`), json({})]),
          ),
          'unsupported-qos',
        ],
        ['foreign topic', mqttPublish('other/topic', '{}'), 'foreign-topic'],
        [
          'foreign device',
          mqttPublish(
            'anycubic/anycubicCloud/v1/slicer/printer/20030/OTHER/info',
            '{}',
          ),
          'foreign-topic',
        ],
        [
          'report topic',
          mqttPublish(`${publicTopic}/info/report`, '{}'),
          'foreign-topic',
        ],
        [
          'truncated topic',
          Buffer.from([0x30, 3, 0, 9, 0x61]),
          'foreign-topic',
        ],
        [
          'nested type',
          mqttPublish(`${slicerTopic}/info/extra`, '{}'),
          'malformed-request',
        ],
        [
          'non-JSON payload',
          mqttPublish(`${slicerTopic}/info`, 'not json'),
          'malformed-request',
        ],
        [
          'JSON scalar',
          mqttPublish(`${slicerTopic}/info`, 'null'),
          'malformed-request',
        ],
        [
          'type mismatch',
          mqttPublish(
            `${slicerTopic}/info`,
            json({ type: 'print', action: 'query', msgid: 'a' }),
          ),
          'malformed-request',
        ],
        [
          'missing msgid',
          mqttPublish(
            `${slicerTopic}/info`,
            json({ type: 'info', action: 'query' }),
          ),
          'malformed-request',
        ],
        [
          'bad action',
          mqttPublish(
            `${slicerTopic}/info`,
            json({ type: 'info', action: 'a b', msgid: 'a' }),
          ),
          'malformed-request',
        ],
      ]
      const expected: Record<string, number> = {}
      for (const [label, bytes, reason] of afterConnect) {
        const client = await session(port)
        client.write(bytes)
        await assert.doesNotReject(client.closedByPeer(), label)
        expected[reason] = (expected[reason] ?? 0) + 1
        assert.deepEqual(fixture.snapshot().closed, expected, label)
      }

      const beforeConnect: [string, Buffer, string][] = [
        ['PINGREQ first', Buffer.from([0xc0, 0]), 'connect-required'],
        ['SUBSCRIBE first', subscribeBytes, 'connect-required'],
        ['empty CONNECT', Buffer.from([0x10, 0]), 'malformed-connect'],
        [
          'wrong protocol name',
          mqttPacket(
            0x10,
            Buffer.concat([
              mqttField('MQIsdp'),
              Buffer.from([3, 2, 0, 60]),
              mqttField('x'),
            ]),
          ),
          'malformed-connect',
        ],
        [
          'will flag',
          mqttPacket(
            0x10,
            Buffer.concat([
              mqttField('MQTT'),
              Buffer.from([4, 0xc6, 0, 60]),
              mqttField('x'),
            ]),
          ),
          'malformed-connect',
        ],
        [
          'trailing bytes',
          Buffer.concat([
            mqttPacket(
              0x10,
              Buffer.concat([
                mqttField('MQTT'),
                Buffer.from([4, 2, 0, 60]),
                mqttField('x'),
                Buffer.from([1]),
              ]),
            ),
          ]),
          'malformed-connect',
        ],
        [
          'oversize before CONNECT',
          Buffer.from([0x10, 0x80, 0x80, 0x40]),
          'oversize',
        ],
      ]
      for (const [label, bytes, reason] of beforeConnect) {
        const client = await open(port)
        client.write(bytes)
        await assert.doesNotReject(client.closedByPeer(), label)
        expected[reason] = (expected[reason] ?? 0) + 1
        assert.deepEqual(fixture.snapshot().closed, expected, label)
      }

      // A wrong filter is refused in-band and never receives reports.
      const wildcard = await open(port)
      wildcard.write(connectBytes())
      assert.equal((await wildcard.next()).header, 0x20)
      wildcard.write(
        mqttPacket(
          0x82,
          Buffer.concat([
            Buffer.from([0, 3]),
            mqttField('#'),
            Buffer.from([0]),
            mqttField('anycubic/anycubicCloud/v1/printer/public/+/+/#'),
            Buffer.from([0]),
          ]),
        ),
      )
      assert.deepEqual(await wildcard.next(), {
        header: 0x90,
        body: Buffer.from([0, 3, 0x80, 0x80]),
      })

      // Plaintext on the TLS port never reaches the MQTT parser.
      const plain = wrap(connectTcp({ port, host: '127.0.0.1' }))
      plain.write(connectBytes())
      await plain.closedByPeer()
      expected['tls-handshake'] = 1
      assert.deepEqual(fixture.snapshot().closed, expected)

      // The session opened first is still served after every rejection.
      healthy.write(request('info', 'query', 'msg-survivor'))
      assert.equal((await healthy.report()).body.msgid, 'msg-survivor')
      assert.equal(fixture.snapshot().subscribed, 1)
      await wildcard.close()
      await healthy.close()
    },
    { maxPacketBytes: 512 },
  )
})

test('deadlines and the client limit bound idle and excess sockets', async () => {
  await withFixture(
    async (fixture, port) => {
      const mute = await open(port)
      await mute.closedByPeer()

      const idle = await session(port)
      await idle.closedByPeer()
      assert.deepEqual(fixture.snapshot().closed, { deadline: 2 })
    },
    { handshakeTimeoutMs: 150, idleTimeoutMs: 150 },
  )

  await withFixture(
    async (fixture, port) => {
      const first = await session(port)
      const second = await session(port)
      const third = await open(port)
      await third.closedByPeer()
      assert.deepEqual(fixture.snapshot().closed, { 'too-many-clients': 1 })
      assert.equal(fixture.snapshot().sessions, 2)
      await first.close()
      await fixture.whenSessions(1, DEADLINE_MS)
      const replacement = await session(port)
      await replacement.close()
      await second.close()
    },
    { maxClients: 2 },
  )
})

test('shutdown drops clients, frees the port and stays loopback', async () => {
  const fixture = createSyntheticMqtt(tls, { identity })
  const { port } = await fixture.start()
  await assert.rejects(fixture.start(), /already started/)
  const live = await session(port)
  const handshaking = wrap(connectTcp({ port, host: '127.0.0.1' }))
  await new Promise<void>((resolve) =>
    handshaking.socket.once('connect', resolve),
  )

  await fixture.stop()
  await live.closedByPeer()
  await handshaking.closedByPeer()
  assert.deepEqual(fixture.snapshot(), {
    listening: false,
    sessions: 0,
    subscribed: 0,
    accepted: 1,
    queries: 0,
    closed: {},
    refused: [],
  })
  await fixture.stop()

  const refusedConnect = connectTcp({ port, host: '127.0.0.1' })
  const [error] = (await new Promise<unknown[]>((resolve) =>
    refusedConnect.once('error', (...args) => resolve(args)),
  )) as [NodeJS.ErrnoException]
  assert.equal(error.code, 'ECONNREFUSED')

  // The same instance can be restarted on a fresh owned port.
  const restarted = await fixture.start()
  const again = await session(restarted.port)
  await again.close()
  await fixture.stop()

  assert.equal(process.env[SYNTHETIC_OWNED_NETWORK_ENV], undefined)
  for (const host of ['0.0.0.0', '192.0.2.1', '::']) {
    await assert.rejects(fixture.start({ host }), /loopback only/)
  }
  await assert.rejects(fixture.start({ host: 'localhost' }), /literal IP/)
  await assert.rejects(fixture.start({ port: 70000 }), RangeError)
  assert.equal(fixture.snapshot().listening, false)
})
