import { test, expect } from 'vitest'
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_ATTRIBUTES,
  configuredAuthOrigin,
  checkMutationOrigin,
} from '../../apps/farm/server/utils/auth/boundary.ts'
const expected = 'https://farm.example'

test('cookie policy is independent, host-only and immutable', () => {
  expect(SESSION_COOKIE_NAME).toBe('__Host-open3dfarmmanager-session')
  expect(SESSION_COOKIE_ATTRIBUTES).toEqual({
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  })
  expect(Object.hasOwn(SESSION_COOKIE_ATTRIBUTES, 'domain')).toBe(false)
  expect(Object.isFrozen(SESSION_COOKIE_ATTRIBUTES)).toBe(true)
  expect(Reflect.set(SESSION_COOKIE_ATTRIBUTES, 'secure', false)).toBe(false)
  expect(Reflect.set(SESSION_COOKIE_ATTRIBUTES, 'domain', '.example')).toBe(
    false,
  )
})
test('only the exact configured HTTPS origin can pass the mutation boundary', () => {
  expect(checkMutationOrigin(expected, expected)).toEqual({ ok: true })
  expect(checkMutationOrigin(expected, expected + '/')).toEqual({ ok: true })
  expect(
    checkMutationOrigin(
      'https://farm.example:8443',
      'https://farm.example:8443',
    ),
  ).toEqual({ ok: true })
  for (const origin of [
    'https://other.example',
    'https://sub.farm.example',
    'https://farm.example.attacker.invalid',
    'https://farm.example:8443',
  ])
    expect(checkMutationOrigin(origin, expected)).toEqual({
      ok: false,
      reason: 'cross-origin',
    })
})
test('missing, opaque, duplicate and malformed Origin headers fail closed', () => {
  for (const origin of [undefined, null])
    expect(checkMutationOrigin(origin, expected)).toEqual({
      ok: false,
      reason: 'missing-origin',
    })
  for (const origin of [
    '',
    'null',
    ['https://farm.example'],
    expected + ', https://other.example',
    expected + ' https://other.example',
    ' ' + expected,
    expected + '/',
    expected + '/path',
    expected + '?x=1',
    expected + '#fragment',
    'https://user@farm.example',
    'http://farm.example',
    'data:text/plain,x',
    'https://FARM.EXAMPLE',
    'x'.repeat(2049),
  ])
    expect(checkMutationOrigin(origin, expected)).toEqual({
      ok: false,
      reason: 'invalid-origin',
    })
})
test('invalid trusted configuration cannot silently become a permissive fallback', () => {
  for (const origin of [
    '',
    'http://farm.example',
    'https://user:password@farm.example',
    expected + '/login',
    expected + '?redirect=other',
    expected + '#fragment',
    ' ' + expected,
    '//farm.example',
    'https://fa\trm.example',
    'https://farm.example\n',
    'https://farm.example\\',
  ]) {
    expect(() => configuredAuthOrigin(origin)).toThrow(
      'Invalid authentication origin configuration',
    )
    expect(() => checkMutationOrigin(expected, origin)).toThrow(
      'Invalid authentication origin configuration',
    )
  }
})
test('headers claiming another origin cannot redefine the trusted deployment origin', () => {
  const spoofed = {
    origin: 'https://attacker.invalid',
    host: 'attacker.invalid',
    forwarded: 'host=attacker.invalid;proto=https',
  }
  expect(checkMutationOrigin(spoofed.origin, expected)).toEqual({
    ok: false,
    reason: 'cross-origin',
  })
})
