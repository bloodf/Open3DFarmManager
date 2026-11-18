import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IntegrationLimits } from '../../apps/farm/server/utils/integration-auth-limits.ts'
import {
  defaultIntegrationRateLimits,
  parseIntegrationRateLimitConfig,
  takeIntegrationRequestLimit,
} from '../../apps/farm/server/utils/integration-rate-limit.ts'

test('integration rate limits have documented defaults and accept configuration', () => {
  assert.deepEqual(defaultIntegrationRateLimits, { read: 120, write: 30 })
  assert.deepEqual(parseIntegrationRateLimitConfig(), { read: 120, write: 30 })
  assert.deepEqual(parseIntegrationRateLimitConfig({ read: '7', write: 3 }), {
    read: 7,
    write: 3,
  })
  assert.throws(() => parseIntegrationRateLimitConfig({ read: 0 }))
  assert.throws(() => parseIntegrationRateLimitConfig({ write: 1.5 }))
})

test('app read and write buckets are separate and return contract headers on 429', () => {
  let now = 10_000
  const buckets = new IntegrationLimits(() => now)
  const config = { read: 2, write: 1 }

  assert.equal(
    takeIntegrationRequestLimit(buckets, 'app-a', 'GET', config).allowed,
    true,
  )
  assert.equal(
    takeIntegrationRequestLimit(buckets, 'app-a', 'GET', config).allowed,
    true,
  )
  const limitedRead = takeIntegrationRequestLimit(
    buckets,
    'app-a',
    'GET',
    config,
  )
  assert.equal(limitedRead.allowed, false)
  assert.deepEqual(limitedRead.headers, {
    'ratelimit-limit': '2',
    'ratelimit-remaining': '0',
    'ratelimit-reset': '60',
    'retry-after': '30',
  })

  assert.equal(
    takeIntegrationRequestLimit(buckets, 'app-a', 'POST', config).allowed,
    true,
  )
  const limitedWrite = takeIntegrationRequestLimit(
    buckets,
    'app-a',
    'DELETE',
    config,
  )
  assert.equal(limitedWrite.allowed, false)
  assert.equal(limitedWrite.headers['ratelimit-limit'], '1')
  assert.equal(limitedWrite.headers['retry-after'], '60')

  assert.equal(
    takeIntegrationRequestLimit(buckets, 'app-b', 'GET', config).allowed,
    true,
  )
  now += 30_000
  const refilled = takeIntegrationRequestLimit(buckets, 'app-a', 'GET', config)
  assert.equal(refilled.allowed, true)
  assert.equal(refilled.headers['ratelimit-remaining'], '0')
})
