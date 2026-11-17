import assert from 'node:assert/strict'
import type { RtcFarmScenario } from './rtc-farm-acceptance-scenarios.ts'
export const RTC_REJECTION_KINDS = [
  'tampered',
  'replayed',
  'expired',
  'wrong-farm',
  'wrong-assignment',
  'revoked-device',
] as const
export type RtcRejectionKind = (typeof RTC_REJECTION_KINDS)[number]

export function rtcRejectionKind(value: string): RtcRejectionKind {
  const kind = RTC_REJECTION_KINDS.find((kind) => kind === value)
  if (!kind) throw Error('Unknown RTC rejection row')
  return kind
}

export type RejectionObservation = Readonly<{
  commandsReceived: number
  prepareCalls: number
  pausesObserved: number
  commandOutcome: string | null
  terminal: boolean
  failed: boolean
}>

export function verifyRtcRejection(
  kind: RtcRejectionKind,
  before: RejectionObservation,
  after: RejectionObservation,
) {
  assert.equal(before.failed, false)
  assert.equal(after.failed, false)
  assert.equal(
    after.prepareCalls,
    before.prepareCalls,
    'Rejected command entered driver',
  )
  assert.equal(
    after.pausesObserved,
    before.pausesObserved,
    'Rejected command paused printer',
  )
  if (kind === 'replayed') {
    assert.equal(after.commandOutcome, 'applied')
    assert.equal(
      before.commandOutcome,
      'applied',
      'Replay needs an accepted original',
    )
    assert.equal(before.commandsReceived, 1)
    assert.equal(before.prepareCalls, 1)
    assert.equal(before.pausesObserved, 1)
    assert.equal(
      after.commandsReceived,
      1,
      'Duplicate must be refused by control session',
    )
    assert.equal(
      after.terminal,
      true,
      'Replay must terminate the real control session',
    )
  } else {
    assert.equal(before.commandsReceived, 0)
    assert.equal(before.prepareCalls, 0)
    assert.equal(before.pausesObserved, 0)
    assert.equal(
      after.commandsReceived,
      1,
      'Command must cross the real RTC channel',
    )
    if (kind === 'revoked-device') assert.equal(after.terminal, true)
    assert.equal(after.commandOutcome, 'rejected')
  }
  return `rtc-command-rejected:${kind}; driver-call-delta:0; pause-delta:0`
}

export function rtcRejectionScenarios(): Record<string, RtcFarmScenario> {
  return Object.fromEntries(
    RTC_REJECTION_KINDS.map((kind) => [
      `command-rejected-${kind}`,
      {
        env: {
          SIGNALLING_HTTPS_PAUSE_RTC_FIXTURE: 'yes',
          SIGNALLING_HTTPS_PAUSE_EXECUTION_RTC_FIXTURE: 'yes',
          SIGNALLING_HTTPS_RTC_REJECTION: kind,
        },
        expect: [
          `rtc-command-rejected:${kind}; driver-call-delta:0; pause-delta:0`,
        ],
      },
    ]),
  )
}
