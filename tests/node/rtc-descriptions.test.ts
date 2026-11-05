import test from 'node:test'
import assert from 'node:assert/strict'
import {
  captureEffectiveRtcDescriptions,
  checkEffectiveRtcDescriptions,
} from '../../packages/connector/src/webrtc/rtc-descriptions.ts'
const browser = Array(32).fill('AA').join(':'),
  connector = Array(32).fill('BB').join(':')
const sdp = (pin: string) => 'v=0\r\na=fingerprint:sha-256 ' + pin + '\r\n'
test('effective getter serialization may differ from transmitted SDP without replacing exact wire hashes', () => {
  const transmitted = sdp(connector) + 'a=ice-options:trickle\r\n'
  const effective = captureEffectiveRtcDescriptions(
    { type: 'answer', sdp: sdp(browser) },
    { type: 'offer', sdp: sdp(connector) },
  )
  assert.notEqual(transmitted, effective.remote.sdp)
  assert.doesNotThrow(() =>
    checkEffectiveRtcDescriptions(
      { browser_dtls: browser, connector_dtls: connector },
      'browser',
      effective,
      effective,
    ),
  )
})
test('changed role pin, later description replacement, rollback and mixed fingerprints fail closed', () => {
  const initial = captureEffectiveRtcDescriptions(
    { type: 'answer', sdp: sdp(browser) },
    { type: 'offer', sdp: sdp(connector) },
  )
  for (const changed of [
    { local: initial.local, remote: { type: 'offer', sdp: sdp(browser) } },
    {
      local: initial.local,
      remote: {
        type: 'offer',
        sdp: initial.remote.sdp + 'a=ice-options:trickle\r\n',
      },
    },
    {
      local: { type: 'rollback', sdp: initial.local.sdp },
      remote: initial.remote,
    },
    {
      local: initial.local,
      remote: { type: 'answer', sdp: initial.remote.sdp },
    },
    {
      local: initial.local,
      remote: {
        type: 'offer',
        sdp: initial.remote.sdp + 'a=fingerprint:sha-1 00:00\r\n',
      },
    },
  ])
    assert.throws(() =>
      checkEffectiveRtcDescriptions(
        { browser_dtls: browser, connector_dtls: connector },
        'browser',
        initial,
        changed,
      ),
    )
  assert.throws(() =>
    checkEffectiveRtcDescriptions(
      { browser_dtls: connector, connector_dtls: browser },
      'browser',
      initial,
      initial,
    ),
  )
})

test('RTCSessionDescription prototype getters are captured explicitly as immutable strings', () => {
  class BrowserDescription {
    get type() {
      return 'answer'
    }
    get sdp() {
      return 'v=0\r\na=fingerprint:sha-256 ' + browser + '\r\n'
    }
  }
  const local = new BrowserDescription()
  const captured = captureEffectiveRtcDescriptions(local, {
    type: 'offer',
    sdp: sdp(connector),
  })
  assert.deepEqual(captured.local, { type: 'answer', sdp: local.sdp })
  assert.doesNotThrow(() =>
    checkEffectiveRtcDescriptions(
      { browser_dtls: browser, connector_dtls: connector },
      'browser',
      captured,
      captured,
    ),
  )
})
