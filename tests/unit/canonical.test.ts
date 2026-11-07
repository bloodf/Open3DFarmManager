import { expect, test } from 'vitest'
import {
  canonicalize,
  base64url,
  decodeBase64url,
} from '@open3dfarmmanager/farm-protocol'

test('canonical JSON sorts recursively and preserves array order', () => {
  expect(canonicalize({ z: [3, { b: true, a: null }], a: 'line\n' })).toBe(
    '{"a":"line\\n","z":[3,{"a":null,"b":true}]}',
  )
})
test('RFC 8785 numerical representations and UTF-16 key order', () => {
  expect(canonicalize([333333333.33333329, 1e30, 4.5, 2e-3, 1e-27, -0])).toBe(
    '[333333333.3333333,1e+30,4.5,0.002,1e-27,0]',
  )
  const keys = ['\ufb33', '😀', '€', 'ö', '\u0080', '1', '\r']
  const result = canonicalize(Object.fromEntries(keys.map((key) => [key, key])))
  expect(Object.keys(JSON.parse(result))).toEqual([
    '1',
    '\r',
    '\u0080',
    'ö',
    '€',
    '😀',
    '\ufb33',
  ])
  expect(result.indexOf('\\r')).toBeLessThan(result.indexOf('"1"'))
})
test.each(
  [
    NaN,
    Infinity,
    undefined,
    1n,
    Symbol('x'),
    new Date(),
    new Map(),
    ['x', undefined],
    new Array(2),
    '\ud800',
    '\udc00',
  ].map((value) => ({ value })),
)('reject non-JSON input %p', ({ value }) => {
  expect(() => canonicalize(value)).toThrow()
})
test('reject cycles and getters without invoking the getter', () => {
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  expect(() => canonicalize(cycle)).toThrow('Cyclic')
  let called = false
  expect(() =>
    canonicalize({
      get value() {
        called = true
        return 1
      },
    }),
  ).toThrow('Accessor')
  expect(called).toBe(false)
})
test('base64url requires exact bytes and canonical unused bits', () => {
  const value = base64url(new Uint8Array(16))
  expect(value).toBe('A'.repeat(22))
  expect(decodeBase64url(value, 16).length).toBe(16)
  expect(() => decodeBase64url('A'.repeat(21) + 'B', 16)).toThrow()
  expect(() => decodeBase64url(value + '==', 16)).toThrow()
})
