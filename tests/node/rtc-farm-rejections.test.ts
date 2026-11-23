import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  RTC_REJECTION_KINDS,
  rtcRejectionScenarios,
  rtcRejectionKind,
  verifyRtcRejection,
} from '../helpers/rtc-farm-rejections.ts'
import {
  RTC_FARM_SCENARIOS,
  selectRtcFarmScenarios,
} from '../helpers/rtc-farm-acceptance-scenarios.ts'
import { rejectionWire } from '../helpers/rtc-farm-rejection-wire.ts'
import {
  decodeCommandV2,
  encodeCommandV2,
  signCommandV2,
  verifyCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'

const empty = {
  commandsReceived: 0,
  prepareCalls: 0,
  pausesObserved: 0,
  commandOutcome: null,
  terminal: false,
  failed: false,
}
const applied = {
  ...empty,
  commandsReceived: 1,
  prepareCalls: 1,
  pausesObserved: 1,
  commandOutcome: 'applied',
}

test('scenario selection rejects inherited property names', () => {
  assert.throws(
    () => selectRtcFarmScenarios('toString'),
    /Unknown RTC farm scenario/,
  )
})

test('all six built-stack rejection rows require their own driver-free receipt', () => {
  assert.deepEqual(RTC_REJECTION_KINDS, [
    'tampered',
    'replayed',
    'expired',
    'wrong-farm',
    'wrong-assignment',
    'revoked-device',
  ])
  for (const [name, row] of Object.entries(rtcRejectionScenarios())) {
    assert.deepEqual(RTC_FARM_SCENARIOS[name], row)
    assert.equal(row.env.SIGNALLING_HTTPS_PAUSE_EXECUTION_RTC_FIXTURE, 'yes')
    assert.equal(row.env.SIGNALLING_HTTPS_PAUSE_RTC_FIXTURE, 'yes')
    const kind = rtcRejectionKind(row.env.SIGNALLING_HTTPS_RTC_REJECTION!)
    const before = kind === 'replayed' ? applied : empty
    const after =
      kind === 'replayed'
        ? { ...applied, terminal: true }
        : {
            ...empty,
            commandsReceived: 1,
            commandOutcome: 'rejected',
            terminal: kind === 'revoked-device',
          }
    assert.deepEqual(row.expect, [verifyRtcRejection(kind, before, after)])
    for (const invalid of [
      { ...after, prepareCalls: after.prepareCalls + 1 },
      { ...after, pausesObserved: after.pausesObserved + 1 },
      { ...after, commandsReceived: 0 },
      { ...after, failed: true },
      {
        ...after,
        commandOutcome: kind === 'replayed' ? 'rejected' : 'applied',
      },
      kind === 'replayed' || kind === 'revoked-device'
        ? { ...after, terminal: false }
        : { ...after, commandOutcome: 'applied' },
    ])
      assert.throws(() => verifyRtcRejection(kind, before, invalid))
    assert.throws(() =>
      verifyRtcRejection(kind, { ...before, prepareCalls: 7 }, after),
    )
  }
  assert.throws(() => rtcRejectionKind('unknown'))
})

test('cross-scope substitutions and expiry are genuinely re-signed; tampering is not', async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const command = {
    v: 2 as const,
    purpose: 'printer-pause' as const,
    cmd_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'acceptance-account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
    action: 'pause' as const,
    args: {},
    issued_at: Date.now(),
    expires_at: Date.now() + 4000,
    nonce: randomBytes(16).toString('base64url'),
  }
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const publicKey = { kty, crv, x, y }
  const signed = await signCommandV2(command, pair.privateKey)
  const wire = encodeCommandV2(signed)
  for (const kind of [
    'tampered',
    'wrong-farm',
    'wrong-assignment',
    'expired',
  ] as const) {
    const mutated = decodeCommandV2(
      await rejectionWire(kind, wire, pair.privateKey),
    )
    assert.equal(await verifyCommandV2(mutated, publicKey), kind !== 'tampered')
    assert.equal(mutated.cmd_id, command.cmd_id)
    if (kind === 'expired') assert.ok(mutated.expires_at < Date.now())
    if (kind === 'wrong-farm' || kind === 'tampered')
      assert.notEqual(mutated.farm_id, command.farm_id)
    if (kind === 'wrong-assignment')
      assert.notEqual(mutated.assignment_id, command.assignment_id)
  }
})

test('checkpoint states actual built-stack evidence rather than treating offline assertions as a run', async () => {
  const doc = await readFile(
    new URL('../../docs/RTC-FARM-ACCEPTANCE-CHECKPOINT.md', import.meta.url),
    'utf8',
  )
  assert.match(doc, /Issue #196/)
  for (const kind of RTC_REJECTION_KINDS)
    assert.ok(doc.includes(`command-rejected-${kind}`))
  assert.match(doc, /[a-f0-9]{40}/)
  assert.match(doc, /Built-stack status/)
  const rejectionSection = doc.slice(doc.indexOf('## Issue #196'))
  assert.match(rejectionSection, /Built-stack status: \*\*passed\*\*/)
  assert.match(rejectionSection, /Validated source commit: `[a-f0-9]{40}`/)
  const rows = rejectionSection
    .split('\n')
    .filter((line) => /^\|\s*`command-rejected-/.test(line))
  assert.equal(rows.length, RTC_REJECTION_KINDS.length)
  for (const kind of RTC_REJECTION_KINDS) {
    const matching = rows.filter(
      (line) => line.split('|')[1]?.trim() === `\`command-rejected-${kind}\``,
    )
    assert.equal(matching.length, 1)
    assert.equal(matching[0]!.split('|')[3]?.trim(), 'pass')
  }
  const printingSection = doc.slice(
    doc.indexOf('### `farm-page-printing-pause` row (#195'),
    doc.indexOf('## Issue #196'),
  )
  const printingRows = printingSection
    .split('\n')
    .filter((line) => /^\|\s*[123]\s*\|/.test(line))
  assert.equal(printingRows.length, 3)
  assert.deepEqual(
    printingRows.map((line) => line.split('|')[1]?.trim()),
    ['1', '2', '3'],
  )
  for (const line of printingRows)
    assert.equal(line.split('|')[2]?.trim(), 'pass')
})
