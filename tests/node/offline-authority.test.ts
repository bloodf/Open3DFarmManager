import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OFFLINE_AUTHORITY_DEFAULT_MS,
  OFFLINE_AUTHORITY_MAX_MS,
  createOfflineAuthority,
  type OfflineAuthorityStaleReason,
} from '../../packages/connector/src/auth/offline-authority.ts'

const T0 = { wall: 1_700_000_000_000, mono: 5_000 }
const at = (ms: number, skew = 0) => ({
  wall: T0.wall + ms + skew,
  mono: T0.mono + ms,
})

function tracker(maxAgeMs?: number) {
  const events: OfflineAuthorityStaleReason[] = []
  const authority = createOfflineAuthority({
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    onStale: (reason) => events.push(reason),
  })
  return { authority, events }
}

test('default lifetime is conservative and the configurable bound is capped', () => {
  assert.equal(OFFLINE_AUTHORITY_DEFAULT_MS, 30_000)
  assert.equal(OFFLINE_AUTHORITY_MAX_MS, 60_000)
  assert.equal(createOfflineAuthority().maxAgeMs, 30_000)
  assert.equal(createOfflineAuthority({ maxAgeMs: 60_000 }).maxAgeMs, 60_000)
  for (const maxAgeMs of [0, -1, 1.5, 60_001, Number.NaN, Infinity])
    assert.throws(() => createOfflineAuthority({ maxAgeMs }))
})

test('never-confirmed authority is stale', () => {
  const { authority, events } = tracker()
  assert.equal(authority.freshAt(T0), false)
  assert.equal(authority.snapshot(), null)
  assert.deepEqual(events, [])
})

test('fresh just before the bound, stale at and after it, audited once', () => {
  const { authority, events } = tracker()
  assert.equal(authority.confirm(T0), true)
  assert.equal(authority.freshAt(at(0)), true)
  assert.equal(authority.freshAt(at(29_999)), true)
  assert.equal(authority.freshAt(at(30_000)), false)
  assert.equal(authority.freshAt(at(30_001)), false)
  assert.deepEqual(events, ['expired'])
  assert.equal(authority.snapshot(), null)
  authority.confirm(at(31_000))
  assert.equal(authority.freshAt(at(60_999)), true)
  assert.equal(authority.freshAt(at(61_000)), false)
  assert.deepEqual(events, ['expired', 'expired'])
})

test('custom bound applies exactly', () => {
  const { authority } = tracker(10_000)
  authority.confirm(T0)
  assert.equal(authority.freshAt(at(9_999)), true)
  assert.equal(authority.freshAt(at(10_000)), false)
})

test('wall clock jumps forwards or backwards fail closed until reconfirmed', () => {
  const forward = tracker()
  forward.authority.confirm(T0)
  assert.equal(forward.authority.freshAt(at(1_000, 1_000)), true)
  assert.equal(forward.authority.freshAt(at(2_000, 3_000)), false)
  assert.equal(forward.authority.freshAt(at(2_001)), false)
  assert.deepEqual(forward.events, ['clock'])

  const backward = tracker()
  backward.authority.confirm(T0)
  assert.equal(backward.authority.freshAt(at(5_000)), true)
  assert.equal(backward.authority.freshAt(at(4_000)), false)
  assert.equal(backward.authority.freshAt(at(6_000)), false)
  assert.deepEqual(backward.events, ['clock'])
  backward.authority.confirm(at(7_000))
  assert.equal(backward.authority.freshAt(at(8_000)), true)
})

test('wall clock set back across the anchor cannot extend authority', () => {
  const { authority, events } = tracker()
  authority.confirm(T0)
  assert.equal(
    authority.freshAt({ wall: T0.wall - 20_000, mono: T0.mono + 1 }),
    false,
  )
  assert.deepEqual(events, ['clock'])
})

test('monotonic regression or invalid samples fail closed', () => {
  for (const bad of [
    { wall: T0.wall + 1_000, mono: T0.mono - 1 },
    { wall: Number.NaN, mono: T0.mono },
    { wall: T0.wall, mono: Number.NaN },
    { wall: -1, mono: T0.mono },
    { wall: 1.5, mono: T0.mono },
  ]) {
    const { authority, events } = tracker()
    authority.confirm(T0)
    assert.equal(authority.freshAt(bad), false)
    assert.deepEqual(events, ['clock'])
  }
  const { authority } = tracker()
  assert.equal(authority.confirm({ wall: Number.NaN, mono: 0 }), false)
  assert.equal(authority.freshAt(T0), false)
})

test('explicit revocation is immediate and audit failures do not restore authority', () => {
  const authority = createOfflineAuthority({
    onStale: () => {
      throw new Error('audit sink down')
    },
  })
  authority.confirm(T0)
  authority.revoke()
  assert.equal(authority.freshAt(at(1)), false)
  const audited = tracker()
  audited.authority.confirm(T0)
  audited.authority.revoke()
  audited.authority.revoke()
  assert.deepEqual(audited.events, ['revoked'])
})

test('restart restores only the remaining wall-clock window', () => {
  const before = createOfflineAuthority()
  before.confirm(T0)
  const persisted = JSON.parse(JSON.stringify(before.snapshot()))
  assert.deepEqual(persisted, { confirmedWall: T0.wall })

  // New process: monotonic clock restarted near zero.
  const after = createOfflineAuthority()
  assert.equal(
    after.restore(persisted, { wall: T0.wall + 10_000, mono: 3 }),
    true,
  )
  assert.equal(after.freshAt({ wall: T0.wall + 29_999, mono: 19_992 }), true)
  assert.equal(after.freshAt({ wall: T0.wall + 30_000, mono: 19_993 }), false)

  const expired = createOfflineAuthority()
  assert.equal(
    expired.restore(persisted, { wall: T0.wall + 30_000, mono: 1 }),
    false,
  )
  assert.equal(expired.freshAt({ wall: T0.wall + 30_000, mono: 1 }), false)

  const clockBack = createOfflineAuthority()
  assert.equal(
    clockBack.restore(persisted, { wall: T0.wall - 1, mono: 1 }),
    false,
  )
  assert.equal(clockBack.freshAt({ wall: T0.wall + 1, mono: 3 }), false)

  const shorter = createOfflineAuthority({ maxAgeMs: 5_000 })
  assert.equal(
    shorter.restore(persisted, { wall: T0.wall + 5_000, mono: 1 }),
    false,
  )

  for (const garbage of [
    null,
    {},
    { confirmedWall: '1' },
    { confirmedWall: 1.5 },
    42,
  ])
    assert.equal(createOfflineAuthority().restore(garbage, T0), false)
})

test('restore after a stale state does not resurrect older authority', () => {
  const { authority } = tracker()
  authority.confirm(T0)
  assert.equal(authority.freshAt(at(30_000)), false)
  assert.equal(authority.snapshot(), null)
  assert.equal(authority.restore({ confirmedWall: T0.wall }, at(30_000)), false)
  assert.equal(authority.freshAt(at(30_001)), false)
})
