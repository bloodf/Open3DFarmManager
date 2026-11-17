// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
const result = JSON.parse(process.env.RESULT)
assert.equal(result.signalling, 'ok', 'TCP signalling must survive each fault')
assert.equal(result.bind, process.env.BIND)
if (process.env.BIND === 'loopback' || process.env.SCENARIO === 'udp-block') {
  assert.equal(result.rtc, 'failed', 'UDP-block and loopback must fail closed')
} else {
  assert.equal(result.rtc, 'open', 'NAT and netem must establish RTC')
  assert.ok(result.echoed > 0, 'data must continue flowing')
  assert.ok(result.openMs <= 10_000, 'RTC opens within 10 s')
}
