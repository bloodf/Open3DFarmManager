// SPDX-License-Identifier: MIT
// Explicit runtime gate only: needs the `rtsp` simulator profile, a built
// rtsp-ingest helper and Playwright Chromium. Never touches printers.
//   CAMERA_RTSP_GATE=1 RTSP_SIM_PORT=<port> RTSP_HELPER_PATH=<abs path>
//   RTSP_HELPER_SHA256=<hex> [CAMERA_HTTP_PORT=<port>]
//   node --test packages/webrtc-experiment/real-identity/camera-rtsp.interop.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from '@playwright/test'
import { browserBundle } from '../../../tests/helpers/browser-bundle.ts'
import {
  RtcSessionBinding,
  rtcDtlsFingerprint,
  rtcSdpHash,
} from '../../farm-protocol/src/rtc-session-binding.ts'
import { assignmentSetDigest } from '../../farm-protocol/src/rtc-assignment-set.ts'
import { FixtureProcess } from './native-media-harness.ts'

const enabled = process.env.CAMERA_RTSP_GATE === '1'
type Module = typeof import('./camera-rtsp-browser.ts')
type Snapshot = ReturnType<Module['snapshot']>
const record = (value: unknown): Record<string, any> => {
  assert.ok(value && typeof value === 'object')
  return value as Record<string, any>
}

async function observe<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
) {
  const start = performance.now()
  while (performance.now() - start < 20000) {
    const value = await read()
    if (ready(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw Error('Observation deadline ' + JSON.stringify(await read()))
}

async function connect(
  page: Page,
  child: FixtureProcess,
  helper: { path: string; sha256: string; port: number },
  authorize: boolean,
) {
  const hello = record(await child.request({ kind: 'hello' }))
  const agent = randomUUID(),
    farm = randomUUID(),
    assignment = randomUUID()
  const refs = [
    { assignmentId: assignment, agentId: agent, printerKey: 'sim-1' },
  ]
  const offer = String(
    record(
      await child.request({
        kind: 'offer',
        agent,
        farm,
        assignment,
        helperPath: helper.path,
        helperSha256: helper.sha256,
        rtspPort: helper.port,
      }),
    ).sdp,
  )
  assert.match(offer, /m=video /)
  assert.match(offer, /a=sendonly/)
  assert.match(offer, /H264\/90000/)
  assert.doesNotMatch(offer, /rtsp:|a=candidate:.*relay/i)
  const browserIdentity = await page.evaluate(async () => {
    const f: Module = await import('/fixture.js' as string)
    return f.identity()
  })
  const answer = await page.evaluate(
    async ({ agent, refs, authorized, offer }) => {
      const f: Module = await import('/fixture.js' as string)
      f.create(agent, refs, authorized)
      return f.answer(offer)
    },
    {
      agent,
      refs,
      authorized: authorize ? [assignment] : [randomUUID()],
      offer,
    },
  )
  assert.match(answer, /a=recvonly/)
  const set = await assignmentSetDigest({ farmId: farm, agentId: agent }, refs)
  const digest = () => randomBytes(32).toString('base64url'),
    now = Date.now()
  const binding = RtcSessionBinding.parse({
    v: 2,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: farm,
    agent_id: agent,
    account_id: 'camera_interop_account',
    key_id: randomUUID(),
    browser_public_key: browserIdentity.publicKey,
    browser_thumbprint: browserIdentity.thumbprint,
    connector_public_key_spki: hello.spki,
    connector_fingerprint: hello.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:connector',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: now,
    expires_at: now + 30000,
    commands_enabled: false,
    offer_sha256: await rtcSdpHash(offer),
    answer_sha256: await rtcSdpHash(answer),
    browser_dtls: rtcDtlsFingerprint(answer),
    connector_dtls: rtcDtlsFingerprint(offer),
    assignment_count: set.count,
    assignment_digest: set.digest,
  })
  await child.request({ kind: 'answer', sdp: answer })
  await child.request({ kind: 'admit', binding })
  await page.evaluate(async (binding) => {
    const f: Module = await import('/fixture.js' as string)
    f.admit(binding)
  }, binding)
  return { hello, assignment }
}

test(
  'RTSP simulator to Chromium over the authenticated Connector RTC track',
  { skip: !enabled, timeout: 120000 },
  async () => {
    const path = process.env.RTSP_HELPER_PATH ?? '',
      sha256 = process.env.RTSP_HELPER_SHA256 ?? '',
      port = Number(process.env.RTSP_SIM_PORT)
    assert.ok(path.startsWith('/') && /^[a-f0-9]{64}$/.test(sha256))
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536)
    const bundle = await browserBundle(
      fileURLToPath(new URL('./camera-rtsp-browser.ts', import.meta.url)),
    )
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/fixture.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' })
        res.end(bundle)
      } else if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<!doctype html><html lang="pt-BR"><title>Câmera simulada</title><body></body></html>',
        )
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    let browser: Browser | undefined, child: FixtureProcess | undefined
    try {
      server.listen(Number(process.env.CAMERA_HTTP_PORT ?? 0), '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      browser = await chromium.launch({ headless: true, timeout: 10000 })
      const page = await browser.newPage()
      await page.goto('http://127.0.0.1:' + address.port, { timeout: 5000 })
      child = new FixtureProcess(process.execPath, './camera-rtsp-child.ts')
      const helper = { path, sha256, port }
      const read = () =>
        page.evaluate(async () => {
          const f: Module = await import('/fixture.js' as string)
          return f.snapshot()
        })

      // Unauthorized assignment: the browser declines only the camera, so the
      // status peer stays verified, the Connector never starts the helper and
      // no video is attached.
      await connect(page, child, helper, false)
      const refused = await observe(
        read,
        (value: Snapshot) =>
          value.peer?.state === 'verified' &&
          value.camera?.state === 'terminal',
      )
      assert.equal(refused.attached, false)
      assert.equal(refused.attachments, 0)
      const refusedNative = record(
        await observe(
          () => child!.request({ kind: 'snapshot' }),
          (value) => record(value).camera?.state === 'terminal',
        ),
      )
      assert.equal(refusedNative.peer.state, 'verified')
      assert.equal(refusedNative.helperPid, undefined)
      assert.equal(refusedNative.camera.sent, 0)
      console.info(JSON.stringify({ stage: 'unauthorized-refused' }))

      const { hello, assignment } = await connect(page, child, helper, true)
      const live = await observe(
        read,
        (value: Snapshot) =>
          value.attached &&
          value.decodedFrames >= 15 &&
          value.callbacks >= 15 &&
          value.distinctFrames >= 5,
      )
      assert.equal(live.printerId, assignment)
      assert.equal(live.width, 320)
      assert.equal(live.height, 240)
      assert.equal(live.peer?.state, 'verified')
      assert.equal(live.peer?.commands_enabled, false)
      assert.doesNotMatch(JSON.stringify(live), /rtsp|8554|127\.0\.0\.1/)
      const native = record(await child.request({ kind: 'snapshot' }))
      assert.equal(native.camera.state, 'live')
      assert.ok(native.camera.sent >= 15)
      assert.ok(Number.isInteger(native.helperPid))
      console.info(
        JSON.stringify({
          stage: 'decoded-rtsp-video',
          node: hello.version,
          libdatachannel: hello.libdatachannel,
          chromium: browser.version(),
          browser: {
            decodedFrames: live.decodedFrames,
            callbacks: live.callbacks,
            distinctFrames: live.distinctFrames,
            width: live.width,
            height: live.height,
          },
          connectorSent: native.camera.sent,
        }),
      )

      const revoked = record(await child.request({ kind: 'revoke' }))
      assert.equal(revoked.synchronous.state, 'terminal')
      assert.equal(revoked.synchronous.trackOpen, false)
      const stopped = await observe(
        read,
        (value: Snapshot) =>
          value.peer?.state === 'readonly' && value.attached === false,
      )
      assert.equal(stopped.detachments, 1)
      const after = record(await child.request({ kind: 'snapshot' }))
      await new Promise((resolve) => setTimeout(resolve, 500))
      const later = await read()
      assert.equal(later.decodedFrames, stopped.decodedFrames)
      assert.equal(later.callbacks, stopped.callbacks)
      assert.deepEqual(
        record(await child.request({ kind: 'snapshot' })).camera,
        after.camera,
      )
      console.info(JSON.stringify({ stage: 'revoked', native: after.camera }))
      await page.close()
    } finally {
      await child?.stop()
      await browser?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
)
