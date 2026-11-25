// SPDX-License-Identifier: MIT
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createKobraXRequests,
  type KobraXReport,
} from '../../packages/connector/src/kobra-x/requests.ts'
import { streamAnycubicJpegs } from '../../packages/connector/src/anycubic/camera.ts'
import { startAnycubicCameraSim } from '../../packages/sim-tools/src/anycubic-camera-sim.ts'

const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])

function report(
  partial: Pick<KobraXReport, 'type' | 'action' | 'msgid'> &
    Partial<KobraXReport>,
): KobraXReport {
  return {
    state: undefined,
    code: undefined,
    data: {},
    ...partial,
  }
}

test('Kobra X does not settle a request from a report msgid belonging to another in-flight request', async () => {
  const published: string[] = []
  const requests = createKobraXRequests({
    topic: (type) => type,
    publish(_topic, payload) {
      published.push((JSON.parse(payload) as { msgid: string }).msgid)
    },
    resultTimeoutMs: 80,
  })
  const first = requests.send({
    type: 'print',
    action: 'start',
    beforeSend: () => true,
  })
  const second = requests.send({
    type: 'print',
    action: 'start',
    beforeSend: () => true,
    resultTimeoutMs: 200,
  })
  assert.equal(published.length, 2)
  const [msgidA, msgidB] = published
  // Same type/action, but msgid names the other request — must not settle first (#616).
  requests.handleReport(
    report({
      type: 'print',
      action: 'start',
      msgid: msgidB!,
      code: 0,
    }),
  )
  assert.equal((await second).kind, 'confirmed')
  const mid = await Promise.race([
    first.then((outcome) => ({ early: true as const, outcome })),
    new Promise<{ early: false }>((resolve) =>
      setTimeout(() => resolve({ early: false }), 20),
    ),
  ])
  assert.equal(mid.early, false)
  // Matching msgid still confirms the remaining request.
  requests.handleReport(
    report({
      type: 'print',
      action: 'start',
      msgid: msgidA!,
      code: 0,
    }),
  )
  assert.equal((await first).kind, 'confirmed')
})

test('Kobra X still settles by type/action when the printer chooses its own report msgid', async () => {
  let requestId = ''
  const requests = createKobraXRequests({
    topic: (type) => type,
    publish(_topic, payload) {
      requestId = (JSON.parse(payload) as { msgid: string }).msgid
    },
    resultTimeoutMs: 200,
    // Firmware that replaces report ids (docs/compatibility/kobra-x-lan.md).
    reportIdentity: 'printer-assigned',
  })
  const pending = requests.send({
    type: 'file',
    action: 'listLocal',
    beforeSend: () => true,
  })
  // S1 printers acknowledge with the request msgid, then answer on /report
  // with a printer-chosen msgid — type+action must still confirm.
  requests.handleAck({ msgid: requestId, code: 0 })
  requests.handleReport(
    report({
      type: 'file',
      action: 'listLocal',
      msgid: 'printer-chosen-msgid',
      code: 200,
    }),
  )
  assert.equal((await pending).kind, 'confirmed')
})

test('Kobra X falls back to type/action when the report has no msgid', async () => {
  let requestId = ''
  const requests = createKobraXRequests({
    topic: (type) => type,
    publish(_topic, payload) {
      requestId = (JSON.parse(payload) as { msgid: string }).msgid
    },
    resultTimeoutMs: 200,
    reportIdentity: 'printer-assigned',
  })
  const pending = requests.send({
    type: 'print',
    action: 'stop',
    beforeSend: () => true,
  })
  requests.handleAck({ msgid: requestId, code: 0 })
  requests.handleReport(
    report({
      type: 'print',
      action: 'stop',
      msgid: '',
      code: 0,
    }),
  )
  assert.equal((await pending).kind, 'confirmed')
})

for (const [label, msgid] of [
  ['printer-chosen', 'printer-chosen-msgid'],
  ['missing', ''],
] as const) {
  test(`Kobra X production default ignores an acknowledged request's ${label} report ID`, async () => {
    // Same exchange as the two qualified cases above, without the flag.
    let requestId = ''
    const requests = createKobraXRequests({
      topic: (type) => type,
      publish(_topic, payload) {
        requestId = (JSON.parse(payload) as { msgid: string }).msgid
      },
      resultTimeoutMs: 40,
    })
    const pending = requests.send({
      type: 'file',
      action: 'listLocal',
      beforeSend: () => true,
    })
    requests.handleAck({ msgid: requestId, code: 0 })
    requests.handleReport(
      report({ type: 'file', action: 'listLocal', msgid, code: 200 }),
    )
    assert.equal((await pending).kind, 'received')
  })
}

test(
  'Anycubic camera resets reconnect attempts after a healthy stream',
  { timeout: 10000 },
  async () => {
    // Each session ends after one frame; without a reset, maxReconnects:1
    // exhausts after two healthy sessions and refuses further reconnects.
    const sim = await startAnycubicCameraSim({ jpeg, frameCount: 1 })
    const controller = new AbortController()
    const frames = streamAnycubicJpegs({
      source: { kind: 'rinkhals', host: sim.host, port: sim.port },
      signal: controller.signal,
      maxReconnects: 1,
      reconnectDelayMs: 1,
    })
    try {
      const collected: Buffer[] = []
      for (let i = 0; i < 4; i++) {
        const next = await frames.next()
        assert.equal(next.done, false)
        collected.push(next.value!)
      }
      assert.equal(collected.length, 4)
      assert.equal(sim.requests, 4)
      controller.abort()
      await frames.return(undefined)
    } finally {
      controller.abort()
      await frames.return(undefined)
      await sim.close()
    }
  },
)
