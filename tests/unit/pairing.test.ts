import { test, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import {
  acceptPairingStart,
  PairingStartRequest,
  PairingStartResponse,
  PairingPublicKey,
  PairingApprovalRequest,
  PairingPollRequest,
  PairingPollResponse,
  normalizePairingCode,
  formatPairingCode,
  parsePairingResponse,
} from '@open3dfarmmanager/farm-protocol'
const key = generateKeyPairSync('ed25519')
  .publicKey.export({ format: 'der', type: 'spki' })
  .toString('base64url')
const id = '00000000-0000-4000-8000-000000000001'
const start = {
  device_code: 'A'.repeat(43),
  user_code: 'BCDF2345',
  fingerprint: 'SHA256:' + 'A'.repeat(43),
  issued_at: 1000,
  expires_at: 901000,
  poll_interval_s: 5,
}

test('Ed25519 public identity shape round trips; private and alternate algorithms are rejected', () => {
  const request = {
    public_key_spki: key,
    platform: 'linux' as const,
    version: '0.0.1',
  }
  expect(
    PairingStartRequest.parse(JSON.parse(JSON.stringify(request))),
  ).toEqual(request)
  const pair = generateKeyPairSync('ed25519')
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  for (const value of [
    pair.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64url'),
    other.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url'),
    key + '=',
    'A'.repeat(59),
  ]) {
    expect(PairingPublicKey.safeParse(value).success).toBe(false)
  }
  expect(
    PairingStartRequest.safeParse({ ...request, private_key: 'forbidden' })
      .success,
  ).toBe(false)
})
test('pairing lifetime and polling bounds are explicit and reject ambiguous encoding', () => {
  expect(PairingStartResponse.parse(start)).toEqual(start)
  for (const changes of [
    { expires_at: 1000 },
    { expires_at: 901001 },
    { issued_at: -1 },
    { issued_at: Number.MAX_SAFE_INTEGER + 1 },
    { poll_interval_s: 0 },
    { device_code: 'A'.repeat(42) + 'B' },
    { fingerprint: 'SHA256:' + 'A'.repeat(42) + 'B' },
  ]) {
    expect(
      PairingStartResponse.safeParse({ ...start, ...changes }).success,
    ).toBe(false)
  }
})
test('human codes normalize only documented formatting and exclude lookalikes', () => {
  expect(normalizePairingCode(' bcdf-2345 ')).toBe('BCDF2345')
  expect(formatPairingCode('BCDF2345')).toBe('BCDF-2345')
  for (const value of [
    'ABCD2345',
    'BCDF0123',
    'BCDFI234',
    'BCDFO234',
    'BCDF\u200b2345',
    'BCDF--2345',
    'BCDF 2345',
    'ＢＣＤＦ2345',
    'BCDF2345\nextra',
    'x'.repeat(33),
  ]) {
    expect(() => normalizePairingCode(value)).toThrow()
  }
  expect(
    PairingStartResponse.safeParse({ ...start, user_code: 'BCDF-2345' })
      .success,
  ).toBe(false)
})
test('approval binds farm and displayed fingerprint but never accepts role or credentials', () => {
  const request = {
    user_code: start.user_code,
    farm_id: id,
    expected_fingerprint: start.fingerprint,
  }
  expect(PairingApprovalRequest.parse(request)).toEqual(request)
  for (const changes of [
    { expected_fingerprint: undefined },
    { farm_id: undefined },
    { role: 'owner' },
    { device_token: 'a.b.c' },
    { public_key_spki: key },
  ]) {
    expect(
      PairingApprovalRequest.safeParse({ ...request, ...changes }).success,
    ).toBe(false)
  }
  expect(
    PairingPollRequest.safeParse({
      device_code: start.device_code,
      user_code: start.user_code,
    }).success,
  ).toBe(false)
})
test('terminal and pending responses cannot smuggle device credentials or commands', () => {
  for (const response of [
    { status: 'pending' as const, retry_after_s: 5 },
    { status: 'slow_down' as const, retry_after_s: 30 },
    { status: 'denied' as const },
    { status: 'expired' as const },
  ]) {
    expect(parsePairingResponse(JSON.stringify(response))).toEqual(response)
    for (const extra of [
      { device_token: 'a.b.c' },
      { action: 'pause' },
      { trusted_keys: [] },
    ])
      expect(
        PairingPollResponse.safeParse({ ...response, ...extra }).success,
      ).toBe(false)
  }
  const approved = {
    status: 'approved' as const,
    agent_id: id,
    farm_id: id,
    device_token: 'test.token.signature',
    expires_at: 1000,
  }
  expect(parsePairingResponse(JSON.stringify(approved))).toEqual(approved)
  for (const token of [
    'Bearer test.token.signature',
    'a.b.c\n',
    'x'.repeat(8193),
  ])
    expect(
      PairingPollResponse.safeParse({ ...approved, device_token: token })
        .success,
    ).toBe(false)
  expect(() => parsePairingResponse(' '.repeat(12289))).toThrow('size limit')
})

test('start acceptance binds the local fingerprint and checks exact validity boundaries', () => {
  expect(acceptPairingStart(start, start.fingerprint, 1000)).toEqual(start)
  expect(acceptPairingStart(start, start.fingerprint, 900999)).toEqual(start)
  expect(() =>
    acceptPairingStart(start, 'SHA256:' + 'B'.repeat(42) + 'A', 1000),
  ).toThrow('mismatch')
  for (const now of [
    999,
    901000,
    901001,
    -1,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() => acceptPairingStart(start, start.fingerprint, now)).toThrow()
  }
})
