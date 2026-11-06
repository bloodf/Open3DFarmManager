import { expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  BrowserDeviceHttpChallengeRequest,
  BrowserDeviceHttpDecisionRequest,
  BrowserDeviceHttpListRequest,
  BrowserDeviceHttpProofRequest,
} from '../../packages/farm-protocol/src/browser-device-http.ts'

test('HTTP contracts constrain pagination and prohibit caller-selected purpose or extra identity', async () => {
  const farm_id = randomUUID()
  expect(BrowserDeviceHttpListRequest.parse({ farm_id })).toEqual({
    farm_id,
    limit: 20,
  })
  for (const limit of [0, 51, 1.5])
    expect(
      BrowserDeviceHttpListRequest.safeParse({ farm_id, limit }).success,
    ).toBe(false)
  expect(
    BrowserDeviceHttpListRequest.safeParse({ farm_id, after: 'invalid' })
      .success,
  ).toBe(false)
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const request = { farm_id, public_key: { kty, crv, x, y } }
  expect(BrowserDeviceHttpChallengeRequest.safeParse(request).success).toBe(
    true,
  )
  for (const extra of [
    { purpose: 'recover' },
    { session_id: 'private' },
    { account_id: 'other' },
  ])
    expect(
      BrowserDeviceHttpChallengeRequest.safeParse({ ...request, ...extra })
        .success,
    ).toBe(false)
  expect(
    BrowserDeviceHttpProofRequest.safeParse({
      challenge_id: randomUUID(),
      signature: 'A'.repeat(86) + '=',
    }).success,
  ).toBe(false)
  expect(
    BrowserDeviceHttpDecisionRequest.safeParse({
      farm_id,
      key_id: randomUUID(),
      expected_thumbprint: 'A'.repeat(43),
      status: 'approved',
    }).success,
  ).toBe(false)
})

import {
  browserDeviceRequest,
  readBrowserDeviceBody,
} from '../../apps/farm/server/services/browser-devices.ts'
import { browserDeviceFixture } from '../helpers/browser-device-http-integration.ts'

test('sealed session is checked before session-specific operation budget', async () => {
  const f = await browserDeviceFixture(),
    farm = randomUUID()
  for (const headers of [
    {},
    { cookie: '__Host-open3dfarmmanager-session=invalid' },
    { authorization: 'Bearer fake' },
  ]) {
    await expect(
      browserDeviceRequest(
        f.event('GET', `/api/browser-devices?farm_id=${farm}`, headers),
        f.runtime,
        'list',
      ),
    ).rejects.toMatchObject({ status: 401 })
  }
  expect(f.limits).toEqual([])
  await expect(
    f.call('list', `/api/browser-devices?farm_id=${farm}`),
  ).rejects.toMatchObject({ status: 403 })
  expect(f.limits).toEqual(['browser-devices:v1:list:session_one'])
  await f.sessions.revokeAccountSessions('account')
  await expect(
    f.call('list', `/api/browser-devices?farm_id=${farm}`),
  ).rejects.toMatchObject({ status: 401 })
  expect(f.limits).toHaveLength(1)
})

test('boundary rejects method, origin, query, malformed JSON and enforces operation namespaces', async () => {
  const f = await browserDeviceFixture(),
    farm = randomUUID()
  await expect(
    f.call(
      'list',
      `/api/browser-devices?farm_id=${farm}`,
      undefined,
      {},
      'POST',
    ),
  ).rejects.toMatchObject({ status: 405 })
  await expect(
    f.call('challenges', '/api/browser-devices/challenges', '{}', {
      origin: 'https://other.example',
    }),
  ).rejects.toMatchObject({ status: 403 })
  await expect(
    f.call('challenges', '/api/browser-devices/challenges', '{}', {
      'content-type': 'text/plain',
    }),
  ).rejects.toMatchObject({ status: 415 })
  for (const query of [
    `farm_id=${farm}&farm_id=${farm}`,
    `farm_id=${farm}&unknown=x`,
    `farm_id=${farm}&limit=51`,
  ])
    await expect(
      f.call('list', `/api/browser-devices?${query}`),
    ).rejects.toMatchObject({ status: 400 })
  await expect(
    f.call(
      'proofs',
      '/api/browser-devices/proofs',
      '{"challenge_id":1,"challenge_id":2}',
    ),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    f.call('approve', '/api/browser-devices/approve', 'x'.repeat(4097)),
  ).rejects.toMatchObject({ status: 413 })
  expect(f.limits).toContain('browser-devices:v1:list:session_one')
  expect(f.limits).toContain('browser-devices:v1:proofs:session_one')
  expect(f.limits).toContain('browser-devices:v1:approve:session_one')
  expect(f.runtime.admission.active).toBe(0)
})

test('body reader rejects malformed UTF-8 and admission capacity releases after failures', async () => {
  const malformed = new Request('https://farm.example.invalid', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new Uint8Array([0xff]),
  })
  await expect(readBrowserDeviceBody(malformed)).rejects.toMatchObject({
    status: 400,
  })
  const f = await browserDeviceFixture()
  f.runtime.admission.active = 16
  await expect(
    f.call('list', `/api/browser-devices?farm_id=${randomUUID()}`),
  ).rejects.toMatchObject({ status: 503 })
  expect(f.runtime.admission.active).toBe(16)
  f.runtime.admission.active = 0
  f.runtime.registry.list = async () => {
    throw new Error('sensitive fixture error')
  }
  await expect(
    f.call('list', `/api/browser-devices?farm_id=${randomUUID()}`),
  ).rejects.toMatchObject({ status: 503 })
  expect(f.runtime.admission.active).toBe(0)
})

test('challenge endpoints fix purpose server-side and reject caller substitution', async () => {
  const f = await browserDeviceFixture(),
    farm_id = randomUUID()
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const request = { farm_id, public_key: { kty, crv, x, y } }
  for (const operation of ['challenges', 'recovery-challenges'] as const)
    await expect(
      f.call(
        operation,
        '/api/browser-devices/' + operation,
        JSON.stringify(request),
      ),
    ).rejects.toMatchObject({ status: 403 })
  expect(
    f.requests.map((value) =>
      typeof value === 'object' && value !== null && 'request' in value
        ? value.request
        : null,
    ),
  ).toEqual([
    { ...request, purpose: 'enroll' },
    { ...request, purpose: 'recover' },
  ])
  await expect(
    f.call(
      'challenges',
      '/api/browser-devices/challenges',
      JSON.stringify({ ...request, purpose: 'recover' }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  expect(f.requests).toHaveLength(2)
})

test('sixteen admitted requests block the seventeenth and release slots', async () => {
  const f = await browserDeviceFixture(),
    farm = randomUUID()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.runtime.registry.list = async () => {
    await gate
    return { ok: false, reason: 'denied' }
  }
  const pending = Array.from({ length: 16 }, () =>
    f
      .call('list', `/api/browser-devices?farm_id=${farm}`)
      .catch((error) => error),
  )
  expect(f.runtime.admission.active).toBe(16)
  await expect(
    f.call('list', `/api/browser-devices?farm_id=${farm}`),
  ).rejects.toMatchObject({ status: 503 })
  release?.()
  const results = await Promise.all(pending)
  expect(results.every((error) => error.status === 403)).toBe(true)
  expect(f.runtime.admission.active).toBe(0)
})

test('body reader terminates a stalled stream', async () => {
  const body = new ReadableStream<Uint8Array>({ start() {} })
  const request = new Request('https://farm.example.invalid', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  await expect(readBrowserDeviceBody(request)).rejects.toMatchObject({
    status: 408,
  })
}, 7000)
