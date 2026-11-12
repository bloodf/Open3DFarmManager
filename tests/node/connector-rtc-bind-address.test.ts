import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_RTC_BIND_ADDRESS,
  isLoopbackBindAddress,
  parseRtcRuntimeConfig,
  rtcBindAddress,
} from '../../packages/connector/src/config/rtc.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { ReadonlyConnectorPeer } from '../../packages/connector/src/webrtc/readonly-peer.ts'
import { PauseConnectorPeer } from '../../packages/connector/src/webrtc/pause-control-peer.ts'
import { SyntheticConnectorPeer } from '../../packages/connector/src/webrtc/synthetic-peer.ts'

test('the RTC bind address accepts only literal IPv4/IPv6 addresses and defaults to loopback', () => {
  assert.equal(DEFAULT_RTC_BIND_ADDRESS, '127.0.0.1')
  assert.deepEqual(parseRtcRuntimeConfig(undefined), {
    bindAddress: '127.0.0.1',
  })
  assert.deepEqual(parseRtcRuntimeConfig({}), { bindAddress: '127.0.0.1' })
  for (const value of [
    '0.0.0.0',
    '::',
    '192.168.1.20',
    '10.0.0.5',
    '::1',
    'fd00::12',
    '2001:db8::1',
  ])
    assert.equal(
      parseRtcRuntimeConfig({ bindAddress: value }).bindAddress,
      value,
    )
  for (const value of [
    'localhost',
    'printer.local',
    'connector.example.com',
    '127.0.0.1:9000',
    '[::1]',
    'fe80::1%eth0',
    ' 127.0.0.1',
    '127.0.0.1 ',
    '',
    '256.1.1.1',
    '1.2.3',
    '01.2.3.4',
    // All interfaces only through the exact literals 0.0.0.0 and ::.
    '0:0:0:0:0:0:0:0',
    '0::',
    '::0',
    '::0.0.0.0',
    '0000::',
    // IPv4-mapped forms: use the IPv4 literal.
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.5',
    '::FFFF:7f00:1',
    '0:0:0:0:0:ffff:a00:5',
    'http://10.0.0.5',
    7,
    null,
  ])
    assert.throws(
      () => parseRtcRuntimeConfig({ bindAddress: value }),
      Error,
      String(value),
    )
  assert.throws(() => parseRtcRuntimeConfig({ bind: '0.0.0.0' }))
  assert.throws(() => parseRtcRuntimeConfig('0.0.0.0'))
  assert.equal(rtcBindAddress(undefined), '127.0.0.1')
  for (const value of ['127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1'])
    assert.equal(isLoopbackBindAddress(value), true, value)
  for (const value of ['0.0.0.0', '::', '192.168.1.20', 'fd00::12'])
    assert.equal(isLoopbackBindAddress(value), false, value)
  assert.throws(() => rtcBindAddress('localhost'))
})

test('the runtime configuration resolves rtc and refuses an invalid address at startup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open3d-rtc-config-'))
  try {
    const farm = randomUUID(),
      agent = randomUUID()
    const origin = 'http://127.0.0.1:9'
    const write = (rtc?: unknown) => {
      const path = join(directory, `runtime-${randomUUID()}.json`)
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          collection: {
            version: 1,
            allowedOrigins: [origin],
            printers: [{ printerKey: 'printer-1', origin: origin + '/' }],
          },
          assignments: [
            {
              assignment_id: randomUUID(),
              farm_id: farm,
              agent_id: agent,
              printer_key: 'printer-1',
              moonraker_origin: origin,
            },
          ],
          telemetry: {
            endpoint: 'https://farm.example/api/connector/telemetry',
            audience: 'connector-audience',
          },
          ...(rtc === undefined ? {} : { rtc }),
        }),
        { mode: 0o600 },
      )
      return path
    }
    const credential = { agent_id: agent, farm_id: farm }
    assert.equal(
      readAgentRuntimeConfig(write(), credential).rtc.bindAddress,
      '127.0.0.1',
    )
    assert.equal(
      readAgentRuntimeConfig(write({ bindAddress: '0.0.0.0' }), credential).rtc
        .bindAddress,
      '0.0.0.0',
    )
    assert.throws(() =>
      readAgentRuntimeConfig(write({ bindAddress: 'farm.local' }), credential),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Host candidate addresses from an SDP offer. */
function candidates(sdp: string) {
  return [
    ...sdp.matchAll(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ host/gm),
  ].map((match) => match[1])
}
// IPv6 loopback differs from the default, so it proves the value is threaded.
const CONFIGURED = '::1'
const identity = () =>
  new ConnectorIdentity(generateKeyPairSync('ed25519').privateKey)

const ipv6Loopback = Object.values(networkInterfaces()).some((entries) =>
  entries?.some((entry) => entry.family === 'IPv6' && entry.address === '::1'),
)
for (const bindAddress of [undefined, CONFIGURED]) {
  const expected = bindAddress ?? '127.0.0.1'
  const skip =
    bindAddress === CONFIGURED && !ipv6Loopback
      ? 'IPv6 loopback (::1) is not configured on this host'
      : false
  test(`readonly peer gathers only on ${expected}`, { skip }, async () => {
    const peer = new ReadonlyConnectorPeer({
      ...(bindAddress ? { bindAddress } : {}),
      identity: identity(),
      expectedAgentId: randomUUID(),
      admittedBinding: new Promise(() => {}),
    })
    try {
      const found = candidates(await peer.offer())
      assert.ok(found.length > 0)
      assert.deepEqual([...new Set(found)], [expected])
    } finally {
      peer.close()
    }
  })
  test(`pause control peer gathers only on ${expected}`, { skip }, async () => {
    const peer = new PauseConnectorPeer({
      ...(bindAddress ? { bindAddress } : {}),
      identity: identity(),
      expected: {
        transportId: randomUUID(),
        farmId: randomUUID(),
        agentId: randomUUID(),
        assignmentId: randomUUID(),
      },
      expectedBinding: new Promise(() => {}),
    })
    try {
      const found = candidates(await peer.offer())
      assert.ok(found.length > 0)
      assert.deepEqual([...new Set(found)], [expected])
    } finally {
      peer.close()
    }
  })
  test(`synthetic peer gathers only on ${expected}`, { skip }, async () => {
    const keys = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const peer = new SyntheticConnectorPeer({
      ...(bindAddress ? { bindAddress } : {}),
      scope: {
        session: randomUUID(),
        browserNonce: 'a'.repeat(64),
        connectorNonce: 'b'.repeat(64),
        browserSpki: 'c'.repeat(64),
        connectorSpki: 'd'.repeat(64),
      },
      privateKey: keys.privateKey,
      remotePublicKey: keys.publicKey,
    })
    try {
      const found = candidates((await peer.offer()).sdp)
      assert.ok(found.length > 0)
      assert.deepEqual([...new Set(found)], [expected])
    } finally {
      peer.peer.close()
    }
  })
}

test('a peer refuses an invalid bind address instead of binding anywhere', () => {
  assert.throws(
    () =>
      new ReadonlyConnectorPeer({
        bindAddress: 'localhost',
        identity: identity(),
        expectedAgentId: randomUUID(),
        admittedBinding: new Promise(() => {}),
      }),
  )
})
