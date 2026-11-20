// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import tls from 'node:tls'
import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  assertLoopbackAddress,
  decryptKobraXCtrlBlob,
  encodePacket,
  generateWrongKobraXClientCert,
  getSimMode,
  installNetworkGuard,
  KOBRA_X_PREPARATION_PHASES,
  KOBRA_X_REPORT_TYPES,
  startKobraXMock,
  startMock,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'

// --- Minimal MQTT 3.1.1 test client helpers (MIT, original, Node built-ins only) ---

function mqttString(value) {
  const buf = Buffer.from(value, 'utf8')
  const len = Buffer.alloc(2)
  len.writeUInt16BE(buf.length)
  return Buffer.concat([len, buf])
}

function encodeConnectPacket({
  clientId = 'kobra-x-test-client',
  username,
  password,
  keepalive = 30,
}) {
  let flags = 0x02 // clean session
  const parts = [mqttString(clientId)]
  if (username !== undefined) {
    flags |= 0x80
    parts.push(mqttString(username))
  }
  if (password !== undefined) {
    flags |= 0x40
    parts.push(mqttString(password))
  }
  const fixedProto = Buffer.from([
    0x00,
    0x04,
    0x4d,
    0x51,
    0x54,
    0x54,
    0x04, // MQTT 3.1.1
    flags,
    (keepalive >> 8) & 0xff,
    keepalive & 0xff,
  ])
  return encodePacket(0x10, Buffer.concat([fixedProto, ...parts]))
}

function encodeSubscribePacket(packetId, topic, qos = 0) {
  const idBuf = Buffer.alloc(2)
  idBuf.writeUInt16BE(packetId)
  return encodePacket(
    0x82,
    Buffer.concat([idBuf, mqttString(topic), Buffer.from([qos])]),
  )
}

function encodePublishPacket(topic, payload) {
  const buf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(
        typeof payload === 'string' ? payload : JSON.stringify(payload),
        'utf8',
      )
  return encodePacket(0x30, Buffer.concat([mqttString(topic), buf]))
}

function decodeMqttPackets(buffer) {
  const packets = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const header = buffer[offset]
    let pos = offset + 1
    let len = 0
    let mult = 1
    let done = false
    while (pos < buffer.length) {
      const byte = buffer[pos++]
      len += (byte & 0x7f) * mult
      if ((byte & 0x80) === 0) {
        done = true
        break
      }
      mult *= 128
    }
    if (!done || pos + len > buffer.length) break
    const body = buffer.subarray(pos, pos + len)
    offset = pos + len
    const packetType = header >> 4
    if (packetType === 3) {
      const topicLen = body.readUInt16BE(0)
      const topic = body.subarray(2, 2 + topicLen).toString('utf8')
      const qos = (header >> 1) & 0x03
      const payloadOffset = 2 + topicLen + (qos === 1 ? 2 : 0)
      const payload = body.subarray(payloadOffset)
      packets.push({ type: packetType, header, topic, payload })
    } else {
      packets.push({ type: packetType, header, body })
    }
  }
  return { packets, rest: buffer.subarray(offset) }
}

async function connectKobraXMqttClient(mock, overrides = {}) {
  const socket = tls.connect({
    host: '127.0.0.1',
    port: mock.mqttPort,
    ca: overrides.ca ?? mock.tls.serverCert,
    cert: 'cert' in overrides ? overrides.cert : mock.tls.clientCert,
    key: 'key' in overrides ? overrides.key : mock.tls.clientKey,
    rejectUnauthorized: overrides.rejectUnauthorized ?? true,
  })

  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })

  let pending = Buffer.alloc(0)
  const queue = []
  let waiters = []
  let closed = false

  const flush = () => {
    while (queue.length > 0 && waiters.length > 0) {
      const w = waiters.shift()
      w(queue.shift())
    }
  }

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    const decoded = decodeMqttPackets(pending)
    pending = decoded.rest
    for (const pkt of decoded.packets) {
      queue.push(pkt)
    }
    flush()
  })

  const closedPromise = new Promise((resolve) => {
    socket.once('close', () => {
      closed = true
      for (const w of waiters) w(null)
      waiters = []
      resolve()
    })
  })
  socket.on('error', () => {})

  const nextPacket = (timeoutMs = 2000) => {
    if (queue.length > 0) return Promise.resolve(queue.shift())
    if (closed) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((x) => x !== onPkt)
        reject(new Error('Timed out waiting for MQTT packet'))
      }, timeoutMs)
      const onPkt = (pkt) => {
        clearTimeout(timer)
        resolve(pkt)
      }
      waiters.push(onPkt)
    })
  }

  const nextJsonMatching = async (predicate, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs
    const stash = []
    while (Date.now() < deadline) {
      const remaining = Math.max(10, deadline - Date.now())
      const pkt = await nextPacket(remaining)
      if (!pkt) break
      if (pkt.type === 3) {
        const json = JSON.parse(pkt.payload.toString('utf8'))
        const item = { topic: pkt.topic, json }
        if (predicate(item)) {
          queue.unshift(...stash)
          return item
        }
      }
      stash.push(pkt)
    }
    queue.unshift(...stash)
    throw new Error('Timed out waiting for matching MQTT JSON message')
  }

  // Send MQTT CONNECT
  socket.write(
    encodeConnectPacket({
      clientId: overrides.clientId ?? 'kobra-x-test-client',
      username:
        'username' in overrides
          ? overrides.username
          : mock.credentials.username,
      password:
        'password' in overrides
          ? overrides.password
          : mock.credentials.password,
    }),
  )
  const connack = await nextPacket()
  assert.ok(connack && connack.type === 2, 'Expected CONNACK packet')
  const returnCode = connack.body[1]

  return {
    socket,
    returnCode,
    closedPromise,
    isClosed: () => closed,
    async subscribe(topic, packetId = 1) {
      socket.write(encodeSubscribePacket(packetId, topic, 0))
      const suback = await nextPacket()
      assert.ok(suback && suback.type === 9, 'Expected SUBACK packet')
      return suback.body[2]
    },
    publish(topic, payload) {
      socket.write(encodePublishPacket(topic, payload))
    },
    nextPacket,
    nextJsonMatching,
    drainAvailable() {
      const out = queue.splice(0, queue.length)
      return out
    },
    async close() {
      if (!closed) {
        socket.destroy()
        await closedPromise
      }
    },
  }
}

async function sendUdpAndReceiveOne(targetPort, payload, timeoutMs = 1000) {
  const sock = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    sock.once('error', reject)
    sock.bind(0, '127.0.0.1', () => {
      sock.removeListener('error', reject)
      resolve()
    })
  })
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('SSDP timeout'))
      }, timeoutMs)
      sock.once('message', (msg, rinfo) => {
        clearTimeout(timer)
        resolve({ msg, rinfo })
      })
      sock.send(payload, targetPort, '127.0.0.1')
    })
  } finally {
    await new Promise((resolve) => sock.close(() => resolve()))
  }
}

test('Kobra X mock binds loopback only under network guard, preserves docker opt-in, and cleans up throwaway TLS', async () => {
  const orig = process.env.OPENFARM_SIM
  try {
    delete process.env.OPENFARM_SIM
    assert.equal(getSimMode(), 'mock')
    process.env.OPENFARM_SIM = 'docker'
    assert.equal(getSimMode(), 'docker')
  } finally {
    if (orig !== undefined) process.env.OPENFARM_SIM = orig
    else delete process.env.OPENFARM_SIM
  }

  installNetworkGuard()
  let tlsDir = ''
  try {
    const mock = await startMock('kobra-x')
    tlsDir = dirname(mock.tls.clientCertPath)
    assert.equal(existsSync(tlsDir), true)
    assertLoopbackAddress({
      address: '127.0.0.1',
      port: mock.mqttPort,
      family: 'IPv4',
    })
    assertLoopbackAddress({
      address: '127.0.0.1',
      port: mock.httpPort,
      family: 'IPv4',
    })
    assertLoopbackAddress({
      address: '127.0.0.1',
      port: mock.ssdpPort,
      family: 'IPv4',
    })
    assertLoopbackAddress({
      address: '127.0.0.1',
      port: mock.flvPort,
      family: 'IPv4',
    })

    // Server certificate must be self-signed (issuer === subject)
    const serverX509 = new X509Certificate(mock.tls.serverCert)
    assert.equal(serverX509.issuer, serverX509.subject)
    const clientX509 = new X509Certificate(mock.tls.clientCert)
    assert.match(clientX509.subject, /CN=AnycubicSlicer/)

    await mock.close()
    assert.equal(existsSync(tlsDir), false)
  } finally {
    uninstallNetworkGuard()
  }
})

test('SSDP responder answers M-SEARCH with an empty 0-byte datagram on loopback sockets', async () => {
  const mock = await startKobraXMock({ camera: false })
  try {
    for (const st of [
      'ac:3dprinter:20030',
      'ac:3dprinter:',
      'ssdp:all',
      'upnp:rootdevice',
    ]) {
      const msearch =
        `M-SEARCH * HTTP/1.1\r\n` +
        `HOST: 239.255.255.250:1900\r\n` +
        `MAN: "ssdp:discover"\r\n` +
        `MX: 2\r\n` +
        `ST: ${st}\r\n\r\n`
      const { msg, rinfo } = await sendUdpAndReceiveOne(
        mock.ssdpPort,
        Buffer.from(msearch),
      )
      assert.equal(msg.length, 0, `Expected empty datagram for ST=${st}`)
      assert.equal(rinfo.address, '127.0.0.1')
      assert.equal(rinfo.port, mock.ssdpPort)
    }

    assert.equal(mock.calls.ssdp.length, 4)

    // Non-M-SEARCH packet must not receive a reply
    await assert.rejects(
      () =>
        sendUdpAndReceiveOne(
          mock.ssdpPort,
          Buffer.from(
            'NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n\r\n',
          ),
          150,
        ),
      /SSDP timeout/,
    )
  } finally {
    await mock.close()
  }

  // Also test caller-provided loopback socket passed to mock and discovery
  const externalSocket = dgram.createSocket('udp4')
  await new Promise((resolve) => externalSocket.bind(0, '127.0.0.1', resolve))
  const mockWithExternalSock = await startKobraXMock({
    camera: false,
    ssdpSocket: externalSocket,
    reuseSharedTls: true,
  })
  try {
    const extPort = externalSocket.address().port
    assert.equal(mockWithExternalSock.ssdpPort, extPort)
    const { msg } = await sendUdpAndReceiveOne(
      extPort,
      Buffer.from('M-SEARCH * HTTP/1.1\r\nST: ssdp:all\r\n\r\n'),
    )
    assert.equal(msg.length, 0)
  } finally {
    await mockWithExternalSock.close()
    await new Promise((resolve) => externalSocket.close(() => resolve()))
  }
})

test('HTTP 18910 serves /info (model 20030, token), /ctrl (AES-128-CBC credentials) and /gcode_upload (file storage)', async () => {
  const mock = await startKobraXMock({
    camera: false,
    reuseSharedTls: true,
    strictCtrlQuery: true,
  })
  try {
    // 1. GET /info
    const infoRes = await fetch(`${mock.httpOrigin}/info`)
    assert.equal(infoRes.status, 200)
    const info = await infoRes.json()
    assert.equal(info.modelId, '20030')
    assert.equal(info.ctrlType, 'lan')
    assert.equal(info.deviceType, 'fdm')
    assert.equal(info.token.length, 32)
    assert.equal(info.ctrlInfoUrl, `${mock.httpOrigin}/ctrl`)
    for (const field of [
      'cn',
      'ctrlInfoUrl',
      'ctrlType',
      'deviceName',
      'deviceType',
      'env',
      'ip',
      'modelId',
      'modelName',
      'token',
      'usn',
      'zone',
    ]) {
      assert.ok(
        typeof info[field] === 'string' && info[field].length > 0,
        field,
      )
    }

    // 2. POST /ctrl (strict params rejected -> valid params return AES-128-CBC blob)
    const badCtrl = await fetch(`${mock.httpOrigin}/ctrl`, { method: 'POST' })
    assert.equal(badCtrl.status, 400)

    const ctrlRes = await fetch(
      `${mock.httpOrigin}/ctrl?ts=${Date.now()}&nonce=abc123&sign=${'a'.repeat(32)}&did=random`,
      { method: 'POST' },
    )
    assert.equal(ctrlRes.status, 200)
    const ctrlBody = await ctrlRes.json()
    assert.equal(ctrlBody.code, 200)
    const decrypted = decryptKobraXCtrlBlob(info.token, ctrlBody.data)
    assert.deepEqual(decrypted, {
      username: mock.credentials.username,
      password: mock.credentials.password,
      deviceId: mock.credentials.deviceId,
      modeId: '20030',
    })

    // 3. POST /gcode_upload
    const gcode = '; Kobra X synthetic gcode\nG28\nG1 X10 Y10 F1200\n'
    const form = new FormData()
    form.set('file', new File([gcode], 'benchy.gcode', { type: 'text/plain' }))

    const badUpload = await fetch(`${mock.httpOrigin}/gcode_upload?s=wrong`, {
      method: 'POST',
      body: form,
    })
    assert.equal(badUpload.status, 401)

    const uploadRes = await fetch(
      `${mock.httpOrigin}/gcode_upload?s=${info.token}`,
      { method: 'POST', body: form },
    )
    assert.equal(uploadRes.status, 200)
    assert.deepEqual(await uploadRes.json(), {
      code: 200,
      data: { gcode: 'benchy.gcode' },
      message: 'success',
    })
    const stored = mock.control.getFiles()
    assert.equal(stored.length, 1)
    assert.equal(stored[0].filename, 'benchy.gcode')
    assert.equal(stored[0].content.toString('utf8'), gcode)
  } finally {
    await mock.close()
  }
})

test('HTTP-FLV camera stream from E16.7 plays without startCapture and rejects bad token', async () => {
  const mock = await startKobraXMock({
    ssdp: false,
    reuseSharedTls: true,
  })
  try {
    assert.ok(mock.flvUrl)
    assert.ok(mock.flvUrl.endsWith(`/live/${mock.credentials.token}`))
    assert.equal(mock.control.getState().infoState, 'free')

    const flvRes = await fetch(mock.flvUrl)
    assert.equal(flvRes.status, 200)
    assert.equal(flvRes.headers.get('content-type'), 'video/x-flv')
    const reader = flvRes.body.getReader()
    const firstChunk = await reader.read()
    assert.equal(
      Buffer.from(firstChunk.value).subarray(0, 3).toString('utf8'),
      'FLV',
    )
    await reader.cancel()

    const badFlv = await fetch(mock.flvUrl + '-bad')
    assert.equal(badFlv.status, 403)
  } finally {
    await mock.close()
  }
})

test('MQTT over mTLS acknowledges on <deviceId>/response and emits <type>/report for all 11 types', async () => {
  const mock = await startKobraXMock({
    ssdp: false,
    reportIntervalMs: 0,
  })
  const deviceId = mock.credentials.deviceId
  const modeId = mock.credentials.modeId
  const client = await connectKobraXMqttClient(mock)

  try {
    assert.equal(client.returnCode, 0)
    const subGrant = await client.subscribe(
      `anycubic/anycubicCloud/v1/slicer/printer/public/${modeId}/${deviceId}/#`,
    )
    assert.equal(subGrant, 0)

    const sendAndVerify = async (type, action, data, expectedAction) => {
      const msgid = `req-${type}-${action}`
      client.publish(
        `anycubic/anycubicCloud/v1/slicer/printer/${modeId}/${deviceId}/${type}`,
        { type, action, msgid, timestamp: Date.now(), data },
      )
      const ack = await client.nextJsonMatching((m) =>
        m.topic.endsWith(`/${deviceId}/response`),
      )
      assert.equal(ack.json.type, '')
      assert.equal(ack.json.action, '')
      assert.equal(ack.json.code, 0)
      assert.equal(ack.json.msgid, msgid)

      const report = await client.nextJsonMatching(
        (m) =>
          m.topic.endsWith(`/${type}/report`) &&
          m.json.action === (expectedAction ?? action),
      )
      assert.equal(report.json.type, type)
      assert.equal(report.json.action, expectedAction ?? action)
      assert.equal(report.json.code, 200)
      assert.notEqual(report.json.msgid, msgid)
      return report.json
    }

    // Seed an uploaded file so file/listLocal & file/fileDetails see it
    mock.control.seedFile('demo.gcode', 'G28\n')

    const infoRep = await sendAndVerify('info', 'query', {}, 'report')
    assert.equal(infoRep.data.state, 'free')
    assert.equal(infoRep.data.project, null)
    assert.equal(infoRep.data.last_project, null)
    assert.equal(infoRep.data.urls.rtspUrl, mock.flvUrl)

    const statusRep = await sendAndVerify('status', 'query', {})
    assert.equal(statusRep.data.state, 'free')

    // For 'print', start then query then stop so print/report is emitted
    const printStartRep = await sendAndVerify('print', 'start', {
      filepath: '/',
      filename: 'demo.gcode',
      taskid: '-1',
    })
    assert.equal(printStartRep.data.filename, 'demo.gcode')

    // Drain preparation phases until printing or stop immediately
    await sendAndVerify('print', 'stop', { taskid: '-1' })

    const tempRep = await sendAndVerify('tempature', 'set', {
      type: 2,
      target_nozzle_temp: 215,
      target_hotbed_temp: 60,
    })
    assert.equal(tempRep.data.target_nozzle_temp, 215)
    assert.equal(tempRep.data.target_hotbed_temp, 60)

    const aceRep = await sendAndVerify('multiColorBox', 'getInfo', {})
    assert.equal(aceRep.data.multi_color_box.length, 1)
    assert.equal(aceRep.data.multi_color_box[0].slots.length, 4)

    const lightRep = await sendAndVerify('light', 'control', {
      type: 3,
      status: 1,
      brightness: 100,
    })
    assert.equal(lightRep.data.status, 1)
    assert.equal(lightRep.data.brightness, 100)

    const fanRep = await sendAndVerify('fan', 'setSpeed', {
      fan_speed_pct: 75,
    })
    assert.equal(fanRep.data.fan_speed_pct, 75)

    const fileRep = await sendAndVerify('file', 'listLocal', {})
    assert.equal(fileRep.data.records[0].filename, 'demo.gcode')
    assert.ok(fileRep.data.records[0].timestamp > 1_000_000_000_000)

    const videoListRep = await sendAndVerify('file', 'listVideo', {
      page_num: 1,
      page_size: 200,
      path: '/',
      keyword: '',
    })
    assert.ok(videoListRep.data.records.length >= 1)
    assert.ok(videoListRep.data.records[0].createTime < 10_000_000_000)

    const axisRep = await sendAndVerify('axis', 'move', {
      axis: 5,
      move_type: 2,
    })
    assert.deepEqual(axisRep.data.position, { x: 0, y: 0, z: 0 })

    const skipRep = await sendAndVerify('skip', 'skipObject', {
      object_id: 2,
    })
    assert.deepEqual(skipRep.data.skipped_objects, [2])

    const videoRep = await sendAndVerify('video', 'startCapture', {})
    assert.equal(videoRep.data.rtspUrl, mock.flvUrl)
    assert.equal(videoRep.data.active, true)

    // Verify every required report type was covered
    for (const type of KOBRA_X_REPORT_TYPES) {
      assert.ok(
        mock.calls.all.some((m) => m.topic.endsWith(`/${type}`)),
        `Expected request published on type ${type}`,
      )
    }
  } finally {
    await client.close()
    await mock.close()
  }
})

test('Scenarios: idle, print with preparation phases -> printing -> finish, 10111 error, ACE feed/retract/drying, and second client reports', async () => {
  const mock = await startKobraXMock({
    ssdp: false,
    camera: false,
    reuseSharedTls: true,
    preparationStepMs: 5,
    trap10111DelayMs: 10,
    reportIntervalMs: 0,
  })
  const deviceId = mock.credentials.deviceId
  const modeId = mock.credentials.modeId
  const clientA = await connectKobraXMqttClient(mock, { clientId: 'client-a' })
  const clientB = await connectKobraXMqttClient(mock, { clientId: 'client-b' })

  try {
    const publicFilter = `anycubic/anycubicCloud/v1/slicer/printer/public/${modeId}/${deviceId}/#`
    assert.equal(await clientA.subscribe(publicFilter), 0)
    assert.equal(await clientB.subscribe(publicFilter), 0)

    // 1. Idle scenario: info/query reports free, print/query returns ack without report
    clientA.publish(
      `anycubic/anycubicCloud/v1/slicer/printer/${modeId}/${deviceId}/print`,
      { type: 'print', action: 'query', msgid: 'idle-pq', data: {} },
    )
    const idleAck = await clientA.nextJsonMatching((m) =>
      m.topic.endsWith(`/${deviceId}/response`),
    )
    assert.equal(idleAck.json.msgid, 'idle-pq')
    await assert.rejects(
      () =>
        clientA.nextJsonMatching((m) => m.topic.endsWith('/print/report'), 120),
      /Timed out/,
    )
    clientB.drainAvailable()

    // 2. Print with preparation phases -> printing -> finish
    await mock.control.startPrint('prep-test.gcode', {
      preparationPhases: KOBRA_X_PREPARATION_PHASES,
      preparationStepMs: 5,
    })
    const seenPhases = []
    for (let i = 0; i < KOBRA_X_PREPARATION_PHASES.length + 1; i++) {
      const rep = await clientA.nextJsonMatching((m) =>
        m.topic.endsWith('/print/report'),
      )
      seenPhases.push(rep.json.state)
      if (rep.json.state !== 'printing') {
        assert.equal(rep.json.data.progress, 0)
        assert.equal(rep.json.data.curr_layer, 0)
        assert.equal(rep.json.data.print_time, 0)
      }
    }
    assert.deepEqual(seenPhases, [...KOBRA_X_PREPARATION_PHASES, 'printing'])

    mock.control.setPrintProgress(50)
    const progRep = await clientA.nextJsonMatching(
      (m) => m.topic.endsWith('/print/report') && m.json.data?.progress === 50,
    )
    assert.equal(progRep.json.data.curr_layer, 50)

    mock.control.finishPrint()
    const finishRep = await clientA.nextJsonMatching(
      (m) => m.topic.endsWith('/print/report') && m.json.state === 'finished',
    )
    assert.equal(finishRep.json.data.progress, 100)
    const postFinishInfo = await clientA.nextJsonMatching((m) =>
      m.topic.endsWith('/info/report'),
    )
    assert.equal(postFinishInfo.json.data.state, 'free')
    assert.equal(postFinishInfo.json.data.project, null)
    clientB.drainAvailable()

    // 3. Printer-ended error (code 10111) via filepath !== '/' trap
    clientA.publish(
      `anycubic/anycubicCloud/v1/slicer/printer/${modeId}/${deviceId}/print`,
      {
        type: 'print',
        action: 'start',
        msgid: 'bad-path-start',
        data: { filepath: '/prep-test.gcode', filename: 'prep-test.gcode' },
      },
    )
    const errRep = await clientA.nextJsonMatching(
      (m) => m.topic.endsWith('/print/report') && m.json.code === 10111,
    )
    assert.equal(errRep.json.state, 'stoped')
    assert.equal(errRep.json.code, 10111)
    assert.equal(mock.control.getState().infoState, 'free')
    clientA.drainAvailable()
    clientB.drainAvailable()

    // 4. ACE feed / retract / drying
    clientA.publish(
      `anycubic/anycubicCloud/v1/slicer/printer/${modeId}/${deviceId}/multiColorBox`,
      {
        type: 'multiColorBox',
        action: 'feed',
        msgid: 'ace-1',
        data: { slot: 2 },
      },
    )
    const feedRep = await clientA.nextJsonMatching(
      (m) =>
        m.topic.endsWith('/multiColorBox/report') && m.json.action === 'feed',
    )
    assert.equal(feedRep.json.data.multi_color_box[0].loaded_slot, 2)
    assert.equal(feedRep.json.data.multi_color_box[0].slots[2].status, 5)

    clientA.publish(
      `anycubic/anycubicCloud/v1/slicer/printer/${modeId}/${deviceId}/multiColorBox`,
      {
        type: 'multiColorBox',
        action: 'retract',
        msgid: 'ace-2',
        data: { slot: 2 },
      },
    )
    const retractRep = await clientA.nextJsonMatching(
      (m) =>
        m.topic.endsWith('/multiColorBox/report') &&
        m.json.action === 'retract',
    )
    assert.equal(retractRep.json.data.multi_color_box[0].loaded_slot, -1)
    assert.equal(retractRep.json.data.multi_color_box[0].slots[2].status, 0)

    clientA.publish(
      `anycubic/anycubicCloud/v1/slicer/printer/${modeId}/${deviceId}/multiColorBox`,
      {
        type: 'multiColorBox',
        action: 'startDrying',
        msgid: 'ace-3',
        data: { target_temp: 55, duration: 180 },
      },
    )
    const dryRep = await clientA.nextJsonMatching(
      (m) =>
        m.topic.endsWith('/multiColorBox/report') &&
        m.json.action === 'startDrying',
    )
    assert.deepEqual(dryRep.json.data.multi_color_box[0].drying_status, {
      status: 1,
      target_temp: 55,
      duration: 180,
      remain_time: 180,
    })

    mock.control.aceStopDrying()
    const dryStopRep = await clientA.nextJsonMatching(
      (m) =>
        m.topic.endsWith('/multiColorBox/report') &&
        m.json.action === 'stopDrying',
    )
    assert.equal(
      dryStopRep.json.data.multi_color_box[0].drying_status.status,
      0,
    )

    // 5. Second client causing reports observed by Client A
    clientA.drainAvailable()
    clientB.publish(
      `anycubic/anycubicCloud/v1/slicer/printer/${modeId}/${deviceId}/file`,
      {
        type: 'file',
        action: 'fileDetails',
        msgid: 'client-b-req',
        data: { root: '/', filename: 'other-client.gcode' },
      },
    )
    const seenByA = await clientA.nextJsonMatching(
      (m) =>
        m.topic.endsWith('/file/report') &&
        m.json.action === 'fileDetails' &&
        m.json.data?.filename === 'other-client.gcode',
    )
    assert.notEqual(seenByA.json.msgid, 'client-b-req')
  } finally {
    await clientA.close()
    await clientB.close()
    await mock.close()
  }
})

test('Faults: wrong client certificate refused, broker drop, and ack without report', async () => {
  const wrongCert = generateWrongKobraXClientCert()
  const mock = await startKobraXMock({
    ssdp: false,
    camera: false,
    reportIntervalMs: 0,
  })
  const deviceId = mock.credentials.deviceId
  const modeId = mock.credentials.modeId

  try {
    // 1a. Missing client certificate refused at TLS handshake
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const sock = tls.connect({
            host: '127.0.0.1',
            port: mock.mqttPort,
            ca: mock.tls.serverCert,
          })
          sock.once('secureConnect', () => {
            // Even if TLS finishes before server validates, server destroys socket on missing cert
            sock.once('close', () => reject(new Error('closed without cert')))
          })
          sock.once('error', reject)
        }),
    )

    // 1b. Wrong client certificate refused at TLS handshake
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const sock = tls.connect({
            host: '127.0.0.1',
            port: mock.mqttPort,
            ca: mock.tls.serverCert,
            cert: wrongCert.cert,
            key: wrongCert.key,
          })
          sock.once('secureConnect', () => {
            sock.once('close', () => reject(new Error('closed wrong cert')))
          })
          sock.once('error', reject)
        }),
    )

    // 1c. Wrong MQTT credentials refused with CONNACK 0x05 even with valid cert
    const badAuthClient = await connectKobraXMqttClient(mock, {
      username: 'wrong-user',
      password: 'wrong-password',
    })
    assert.equal(badAuthClient.returnCode, 5)
    await badAuthClient.closedPromise

    // 2. Ack without report (fault on REPORT stalls report while ACK still arrives)
    const client = await connectKobraXMqttClient(mock)
    assert.equal(client.returnCode, 0)
    await client.subscribe(
      `anycubic/anycubicCloud/v1/slicer/printer/public/${modeId}/${deviceId}/#`,
    )

    mock.control.faults.setFault({
      method: 'REPORT',
      count: 1,
      fault: { type: 'stall' },
    })
    client.publish(
      `anycubic/anycubicCloud/v1/slicer/printer/${modeId}/${deviceId}/info`,
      { type: 'info', action: 'query', msgid: 'ack-only-1', data: {} },
    )
    const ack = await client.nextJsonMatching((m) =>
      m.topic.endsWith(`/${deviceId}/response`),
    )
    assert.equal(ack.json.msgid, 'ack-only-1')
    assert.equal(ack.json.code, 0)
    await assert.rejects(
      () =>
        client.nextJsonMatching((m) => m.topic.endsWith('/info/report'), 120),
      /Timed out/,
    )

    // 3. Broker drop fault
    mock.control.faults.setFault({
      method: 'PUBLISH',
      count: 1,
      fault: { type: 'drop' },
    })
    client.publish(
      `anycubic/anycubicCloud/v1/slicer/printer/${modeId}/${deviceId}/status`,
      { type: 'status', action: 'query', msgid: 'drop-1', data: {} },
    )
    await client.closedPromise
    assert.equal(client.isClosed(), true)
  } finally {
    wrongCert.cleanup()
    await mock.close()
  }
})
