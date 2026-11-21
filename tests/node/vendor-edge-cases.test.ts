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

test('Kobra X does not settle a request from a same type/action report with a different msgid', async () => {
  let publishedMsgid = ''
  const requests = createKobraXRequests({
    topic: (type) => type,
    publish(_topic, payload) {
      publishedMsgid = (JSON.parse(payload) as { msgid: string }).msgid
    },
    resultTimeoutMs: 80,
  })
  const pending = requests.send({
    type: 'print',
    action: 'start',
    beforeSend: () => true,
  })
  // Same type/action, different msgid — must not resolve the pending request (#616).
  requests.handleReport(
    report({
      type: 'print',
      action: 'start',
      msgid: 'other-request-msgid',
      code: 0,
    }),
  )
  const mid = await Promise.race([
    pending.then((outcome) => ({ early: true as const, outcome })),
    new Promise<{ early: false }>((resolve) =>
      setTimeout(() => resolve({ early: false }), 20),
    ),
  ])
  assert.equal(mid.early, false)
  assert.ok(publishedMsgid)
  // Matching msgid still confirms.
  requests.handleReport(
    report({
      type: 'print',
      action: 'start',
      msgid: publishedMsgid,
      code: 0,
    }),
  )
  assert.equal((await pending).kind, 'confirmed')
})

test('Kobra X falls back to type/action only when the report has no msgid', async () => {
  const requests = createKobraXRequests({
    topic: (type) => type,
    publish() {},
    resultTimeoutMs: 200,
  })
  const pending = requests.send({
    type: 'print',
    action: 'stop',
    beforeSend: () => true,
  })
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
