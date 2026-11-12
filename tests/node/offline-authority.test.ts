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
  return { authority, fresh: authority.freshness.freshAt, events }
}

test('default lifetime is conservative and the configurable bound is capped', () => {
  assert.equal(OFFLINE_AUTHORITY_DEFAULT_MS, 30_000)
  assert.equal(OFFLINE_AUTHORITY_MAX_MS, 60_000)
  assert.equal(createOfflineAuthority().maxAgeMs, 30_000)
  assert.equal(createOfflineAuthority({ maxAgeMs: 60_000 }).maxAgeMs, 60_000)
  for (const maxAgeMs of [0, -1, 1.5, 60_001, Number.NaN, Infinity])
    assert.throws(() => createOfflineAuthority({ maxAgeMs }))
})

test('freshness view is frozen and read-only', () => {
  const { authority } = tracker()
  assert.ok(Object.isFrozen(authority.freshness))
  assert.deepEqual(Object.keys(authority.freshness), ['freshAt'])
})

test('never-confirmed authority, including after a restart, is stale', () => {
  const { fresh, events } = tracker()
  assert.equal(fresh(T0), false)
  assert.deepEqual(events, [])
})

test('fresh just before the bound, stale at and after it, audited once', () => {
  const { authority, fresh, events } = tracker()
  assert.equal(authority.confirm(T0, 1), true)
  assert.equal(fresh(at(0)), true)
  assert.equal(fresh(at(29_999)), true)
  assert.equal(fresh(at(30_000)), false)
  assert.equal(fresh(at(30_001)), false)
  assert.deepEqual(events, ['expired'])
  assert.equal(authority.confirm(at(31_000), 2), true)
  assert.equal(fresh(at(60_999)), true)
  assert.equal(fresh(at(61_000)), false)
  assert.deepEqual(events, ['expired', 'expired'])
})

test('custom bound applies exactly', () => {
  const { authority, fresh } = tracker(10_000)
  authority.confirm(T0, 1)
  assert.equal(fresh(at(9_999)), true)
  assert.equal(fresh(at(10_000)), false)
})

test('wall clock jumps forwards or backwards fail closed until reconfirmed', () => {
  const forward = tracker()
  forward.authority.confirm(T0, 1)
  assert.equal(forward.fresh(at(1_000, 1_000)), true)
  assert.equal(forward.fresh(at(2_000, 3_000)), false)
  assert.equal(forward.fresh(at(2_001)), false)
  assert.deepEqual(forward.events, ['clock'])

  const backward = tracker()
  backward.authority.confirm(T0, 1)
  assert.equal(backward.fresh(at(5_000)), true)
  assert.equal(backward.fresh(at(4_000)), false)
  assert.equal(backward.fresh(at(6_000)), false)
  assert.deepEqual(backward.events, ['clock'])
  backward.authority.confirm(at(7_000), 2)
  assert.equal(backward.fresh(at(8_000)), true)
})

test('wall clock set back across the anchor cannot extend authority', () => {
  const { authority, fresh, events } = tracker()
  authority.confirm(T0, 1)
  assert.equal(fresh({ wall: T0.wall - 20_000, mono: T0.mono + 1 }), false)
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
    const { authority, fresh, events } = tracker()
    authority.confirm(T0, 1)
    assert.equal(fresh(bad), false)
    assert.deepEqual(events, ['clock'])
  }
  const { authority, fresh } = tracker()
  assert.equal(authority.confirm({ wall: Number.NaN, mono: 0 }, 1), false)
  assert.equal(fresh(T0), false)
})

test('confirm requires a strictly increasing server sequence', () => {
  const { authority, fresh } = tracker()
  for (const seq of [Number.NaN, 1.5, Infinity])
    assert.equal(authority.confirm(T0, seq), false)
  assert.equal(fresh(T0), false)
  assert.equal(authority.confirm(T0, 5), true)
  assert.equal(fresh(at(30_000)), false)
  assert.equal(authority.confirm(at(30_001), 5), false)
  assert.equal(authority.confirm(at(30_001), 4), false)
  assert.equal(fresh(at(30_001)), false)
  assert.equal(authority.confirm(at(30_002), 6), true)
  assert.equal(fresh(at(30_003)), true)
})

test('explicit revocation is immediate and audit failures do not restore authority', () => {
  const authority = createOfflineAuthority({
    onStale: () => {
      throw new Error('audit sink down')
    },
  })
  authority.confirm(T0, 1)
  authority.revoke()
  assert.equal(authority.freshness.freshAt(at(1)), false)
  const audited = tracker()
  audited.authority.confirm(T0, 1)
  audited.authority.revoke()
  audited.authority.revoke()
  assert.deepEqual(audited.events, ['revoked'])
})

test('after revocation only a newer confirm restores authority', () => {
  const { authority, fresh } = tracker()
  authority.confirm(T0, 3)
  authority.revoke(10)
  // Time passing, clock samples and stale or pre-revocation confirms all stay stale.
  for (const ms of [0, 1, 1_000, 29_999]) assert.equal(fresh(at(ms)), false)
  for (const seq of [3, 4, 9, 10])
    assert.equal(authority.confirm(at(2_000), seq), false)
  assert.equal(fresh(at(2_001)), false)
  authority.revoke(7) // A lower floor never lowers the current one.
  assert.equal(authority.confirm(at(3_000), 10), false)
  assert.equal(authority.confirm(at(3_000), 11), true)
  assert.equal(fresh(at(3_001)), true)
})

test('revoke without a sequence still blocks replay of the last confirm', () => {
  const { authority, fresh } = tracker()
  authority.confirm(T0, 3)
  authority.revoke()
  assert.equal(authority.confirm(at(1), 3), false)
  assert.equal(fresh(at(2)), false)
  assert.equal(authority.confirm(at(3), 4), true)
})
