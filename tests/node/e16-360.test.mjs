import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { probeRtcBackend } from '../../packages/connector/src/webrtc/rtc-backend.ts'
import {
  openLocalStatus,
  projectStatus,
} from '../../packages/connector/src/status/local.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const src = (p) => readFileSync(join(root, p), 'utf8')
const failing =
  (code, message = 'x') =>
  () =>
    Promise.reject(Object.assign(new Error(message), { code }))

test('probe reports direct when the native module loads', async () => {
  const status = await probeRtcBackend(async () => ({
    PeerConnection: class {},
  }))
  assert.deepEqual(status, { backend: 'node-datachannel', mode: 'direct' })
})

test('probe reports read-only degraded when the binary is absent', async () => {
  const cases = [
    failing('ERR_MODULE_NOT_FOUND'),
    failing('MODULE_NOT_FOUND'),
    failing(undefined, "Cannot find module '/x/node_datachannel.node'"),
  ]
  for (const load of cases)
    assert.deepEqual(await probeRtcBackend(load), {
      backend: 'none',
      mode: 'read-only-degraded',
      reason: 'native-binary-missing',
    })
})

test('probe classifies other failures and malformed modules', async () => {
  const expected = {
    backend: 'none',
    mode: 'read-only-degraded',
    reason: 'native-load-failed',
  }
  assert.deepEqual(
    await probeRtcBackend(failing('ERR_DLOPEN_FAILED', 'wrong arch')),
    expected,
  )
  assert.deepEqual(await probeRtcBackend(async () => ({})), expected)
  assert.deepEqual(await probeRtcBackend(async () => null), expected)
})

test('probe result never carries error text or paths', async () => {
  const status = await probeRtcBackend(
    failing('ERR_MODULE_NOT_FOUND', '/secret/home/dir/node_datachannel.node'),
  )
  assert.ok(!JSON.stringify(status).includes('secret'))
})

test('real probe in this install returns a valid status', async () => {
  const status = await probeRtcBackend()
  assert.ok(['direct', 'read-only-degraded'].includes(status.mode))
  assert.equal(status.mode === 'direct', status.backend === 'node-datachannel')
})

test('status projection carries the backend and drops invalid values', () => {
  const base = {
    queueDepth: 0,
    delivered: 0,
    retries: 0,
    credentialExpired: false,
  }
  assert.deepEqual(
    projectStatus({
      ...base,
      rtc: {
        backend: 'none',
        mode: 'read-only-degraded',
        reason: 'native-binary-missing',
      },
    }).rtc,
    {
      backend: 'none',
      mode: 'read-only-degraded',
      reason: 'native-binary-missing',
    },
  )
  assert.deepEqual(
    projectStatus({
      ...base,
      rtc: { backend: 'node-datachannel', mode: 'direct' },
    }).rtc,
    { backend: 'node-datachannel', mode: 'direct' },
  )
  assert.equal('rtc' in projectStatus(base), false)
  assert.equal(
    'rtc' in
      projectStatus({ ...base, rtc: { backend: 'evil', mode: 'direct' } }),
    false,
  )
  const forged = projectStatus({
    ...base,
    rtc: { backend: 'none', mode: 'direct', reason: '<script>' },
  })
  assert.deepEqual(forged.rtc, { backend: 'none', mode: 'read-only-degraded' })
})

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ code: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('local status endpoint and page show the active backend', async () => {
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))
  const rtc = await probeRtcBackend(failing('ERR_MODULE_NOT_FOUND'))
  const status = await openLocalStatus({
    port,
    read: () => ({
      queueDepth: 1,
      delivered: 2,
      retries: 0,
      credentialExpired: false,
      rtc,
    }),
    onError: (e) => {
      throw e
    },
  })
  try {
    const json = await get(port, '/status')
    assert.deepEqual(JSON.parse(json.body).rtc, {
      backend: 'none',
      mode: 'read-only-degraded',
      reason: 'native-binary-missing',
    })
    const page = await get(port, '/')
    assert.match(page.body, /Backend WebRTC/)
    assert.match(page.body, /somente leitura degradado/)
  } finally {
    await status.close()
  }
})

test('agent probes at startup and gates RTC on the direct backend', () => {
  const agent = src('packages/connector/src/runtime/agent.ts')
  assert.match(agent, /probeRtcBackend\(\)/)
  assert.match(agent, /kind: 'rtc-backend'/)
  assert.match(agent, /rtc: rtcBackend/)
  assert.match(agent, /rtcBackend\.mode === 'direct'/)
})

test('peers keep no-TURN, pinning and loopback protections', () => {
  const dir = 'packages/connector/src/webrtc'
  const peers = readdirSync(join(root, dir)).filter((f) =>
    f.endsWith('-peer.ts'),
  )
  assert.ok(peers.length >= 4)
  for (const f of peers) {
    const text = src(`${dir}/${f}`)
    if (!text.includes('new PeerConnection')) continue
    assert.match(text, /iceServers: \[\]/, f)
    assert.match(text, /disableFingerprintVerification: false/, f)
    assert.doesNotMatch(text, /disableFingerprintVerification: true/, f)
  }
})

test('decision document records the outcome and measured limits plan', () => {
  const doc = src('docs/RTC-BACKEND-DECISION.md')
  for (const term of [
    'werift',
    'read-only-degraded',
    'Measurements required',
    'native-binary-missing',
  ])
    assert.ok(doc.includes(term), term)
  assert.match(doc, /no STUN, no\s+TURN/)
  assert.doesNotMatch(doc, /WebSocket relay is built/i)
})

test('existing local status suite still passes', () => {
  execFileSync(
    process.execPath,
    [
      '--test',
      '--test-force-exit',
      'tests/node/connector-local-status.test.ts',
    ],
    { cwd: root, stdio: 'pipe', timeout: 110000 },
  )
})
