import { test, expect } from 'bun:test'
import {
  parseBoundedJson,
  decodeSignallingFrame,
  JsonReadError,
} from '@open3dfarmmanager/farm-protocol'

test('duplicate keys are rejected after escape decoding, at every object depth', () => {
  for (const source of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '[{"nested":{"x":1,"x":2}}]',
    '{"😀":1,"\\ud83d\\ude00":2}',
    '{"a\\\\b":1,"a\\u005cb":2}',
  ])
    expect(() => parseBoundedJson(source)).toThrow('duplicate-key')
  expect(parseBoundedJson('{"left":{"a":1},"right":{"a":2}}')).toEqual({
    left: { a: 1 },
    right: { a: 2 },
  })
})
test('string escapes, brackets within strings and valid Unicode match native JSON', () => {
  for (const source of [
    '"\\\"{}[]"',
    '"\\\\"',
    '"\\b\\f\\n\\r\\t\\/"',
    '"\\ud83d\\ude00"',
    '{"é":"é"}',
    ' \n[true,false,null,-0,1.25e-3,1E+20]\t ',
  ])
    expect(parseBoundedJson(source)).toEqual(JSON.parse(source))
  // Unicode normalization is intentionally not applied to property names.
  expect(parseBoundedJson('{"é":1,"é":2}')).toEqual({ é: 1, é: 2 })
})
test('reject malformed syntax without exposing untrusted text in errors', () => {
  for (const source of [
    '',
    ' ',
    '01',
    '+1',
    '1.',
    '.1',
    '1e',
    'NaN',
    'Infinity',
    '[1,]',
    '{"a":1,}',
    '[,]',
    'true false',
    'nullx',
    '\ufeff{}',
    '/*x*/{}',
    '{"x":"\\x41"}',
    '"raw\nnewline"',
    '{"PRIVATE_VALUE":',
  ]) {
    try {
      parseBoundedJson(source)
      throw new Error('Unexpected success')
    } catch (error) {
      expect(error).toBeInstanceOf(JsonReadError)
      expect(String(error)).not.toContain('PRIVATE_VALUE')
    }
  }
})
test('nonfinite numbers and lone surrogates are explicitly rejected', () => {
  for (const source of ['1e309', '-1e309'])
    expect(() => parseBoundedJson(source)).toThrow('nonfinite-number')
  for (const source of ['"\\ud800"', '"\\udc00"', '"\ud800"', '{"\\ud800":0}'])
    expect(() => parseBoundedJson(source)).toThrow('invalid-unicode')
})
test('byte, string, depth and value limits hold at exact boundaries', () => {
  expect(parseBoundedJson('"é"', { maxBytes: 4 })).toBe('é')
  expect(() => parseBoundedJson('"é"', { maxBytes: 3 })).toThrow('size-limit')
  expect(parseBoundedJson('"abc"', { maxStringChars: 3 })).toBe('abc')
  expect(() => parseBoundedJson('"abcd"', { maxStringChars: 3 })).toThrow(
    'string-limit',
  )
  expect(() => parseBoundedJson('{"abcd":1}', { maxStringChars: 3 })).toThrow(
    'string-limit',
  )
  expect(parseBoundedJson('[[0]]', { maxDepth: 3 })).toEqual([[0]])
  expect(() => parseBoundedJson('[[0]]', { maxDepth: 2 })).toThrow(
    'depth-limit',
  )
  expect(parseBoundedJson('[1,2]', { maxValues: 3 })).toEqual([1, 2])
  expect(() => parseBoundedJson('[1,2,3]', { maxValues: 3 })).toThrow(
    'value-limit',
  )
  expect(() =>
    parseBoundedJson('['.repeat(10000) + '0' + ']'.repeat(10000)),
  ).toThrow('depth-limit')
})
test('prototype-like properties remain own data and do not pollute Object.prototype', () => {
  const value = parseBoundedJson(
    '{"__proto__":{"polluted":true},"constructor":"data"}',
  ) as Record<string, unknown>
  expect(Object.hasOwn(value, '__proto__')).toBe(true)
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
})
test('invalid limits fail before decoding', () => {
  for (const limits of [
    { maxBytes: 0 },
    { maxDepth: 65 },
    { maxValues: Infinity },
    { maxStringChars: 1.5 },
    { maxBytes: 1_048_577 },
  ])
    expect(() => parseBoundedJson('{}', limits)).toThrow('invalid-limits')
})
test('deterministic generated documents agree with native JSON across formatting variations', () => {
  let seed = 123456789
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  function generate(depth: number): unknown {
    const choice = next() % (depth > 0 ? 7 : 5)
    switch (choice) {
      case 0:
        return null
      case 1:
        return next() % 2 === 0
      case 2:
        return (next() - 0x80000000) / 1000
      case 3:
        return ['é', '😀', '\\', '"', '\n', '[]{}', ''][next() % 7]
      case 4:
        return next()
      case 5:
        return Array.from({ length: next() % 5 }, () => generate(depth - 1))
      default:
        return Object.fromEntries(
          Array.from({ length: next() % 5 }, (_, index) => [
            'key' + index,
            generate(depth - 1),
          ]),
        )
    }
  }
  for (let index = 0; index < 500; index++) {
    const source = JSON.stringify(generate(4), null, index % 3)
    expect(parseBoundedJson(source)).toEqual(JSON.parse(source))
  }
})

test('mutated documents never bypass native JSON grammar', () => {
  let seed = 314159
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed
  }
  const originals = [
    '{"a":[1,true,null,"text"],"b":{}}',
    '[0,-1,1.5,2e3]',
    '"escaped\\\\quote\\\""',
  ]
  const insertions = ['"', '\\', ',', ':', ']', '}', '\n', '0', 'x']
  for (let index = 0; index < 2000; index++) {
    const original = originals[next() % originals.length]!
    const position = next() % (original.length + 1)
    const source =
      original.slice(0, position) +
      insertions[next() % insertions.length]! +
      original.slice(position + (next() % 2))
    let native: unknown
    let valid = true
    try {
      native = JSON.parse(source)
    } catch {
      valid = false
    }
    if (!valid) expect(() => parseBoundedJson(source)).toThrow(JsonReadError)
    else {
      // Duplicate keys and Unicode/number restrictions are intentionally stricter.
      try {
        expect(parseBoundedJson(source)).toEqual(native)
      } catch (error) {
        if (
          !(error instanceof JsonReadError) ||
          !['duplicate-key', 'invalid-unicode', 'nonfinite-number'].includes(
            error.code,
          )
        )
          throw error
      }
    }
  }
})
test('signalling decoder applies both bounded JSON and the existing strict message schema', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const ping = { id, ts: 1000, t: 'ping' as const, p: {} }
  const wire = JSON.stringify(ping)
  expect(decodeSignallingFrame(wire)).toEqual(ping)
  expect(() =>
    decodeSignallingFrame(wire.replace('"ts":1000', '"ts":1000,"ts":2000')),
  ).toThrow('duplicate-key')
  expect(() =>
    decodeSignallingFrame(JSON.stringify({ ...ping, action: 'pause' })),
  ).toThrow()
  expect(() => decodeSignallingFrame(' '.repeat(8193))).toThrow('size-limit')
  const offer = {
    id,
    ts: 1000,
    t: 'rtc.offer' as const,
    p: { agent_id: id, viewer_id: id, sdp: 'v=0\r\n' },
  }
  expect(decodeSignallingFrame(JSON.stringify(offer))).toEqual(offer)
})
