import { test, expect } from 'vitest'
import { createLogger, redact } from '../../packages/shared/src/log.ts'

function capture() {
  const lines: string[] = []
  const log = createLogger(
    'srv',
    (l) => lines.push(l),
    () => new Date('2026-01-01T00:00:00Z'),
  )
  return { lines, log }
}

test('emits one JSON line with ts, level, name, msg', () => {
  const { lines, log } = capture()
  log.info('hello', { printer: 'p1' })
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]!)).toEqual({
    printer: 'p1',
    ts: '2026-01-01T00:00:00.000Z',
    level: 'info',
    name: 'srv',
    msg: 'hello',
  })
})

test('redacts sensitive keys including nested objects and arrays', () => {
  const { lines, log } = capture()
  log.warn('x', {
    password: 'p',
    headers: { Authorization: 'Bearer abc', Cookie: 'sid=1', accept: 'json' },
    nested: [
      {
        privateKey: 'k',
        signature: 's',
        proofMaterial: 'm',
        pairingCode: '123456',
        ok: 1,
      },
    ],
    sessionToken: 't',
    credentials: { a: 1 },
  })
  const out = lines[0]!
  for (const secret of [
    '"p"',
    'abc',
    'sid=1',
    '"k"',
    '"s"',
    '"m"',
    '123456',
    '"t"',
  ]) {
    expect(out).not.toContain(secret)
  }
  const parsed = JSON.parse(out)
  expect(parsed.headers.accept).toBe('json')
  expect(parsed.nested[0].ok).toBe(1)
  expect(parsed.credentials).toBe('[REDACTED]')
})

test('redacts secrets in error objects and causes', () => {
  const cause = new Error('inner Bearer tok.en-1')
  const err = Object.assign(
    new Error('failed with Bearer secret123', { cause }),
    {
      token: 'abc',
      config: { password: 'pw' },
    },
  )
  const { lines, log } = capture()
  log.error('boom', { error: err })
  const out = lines[0]!
  expect(out).not.toMatch(/secret123|tok\.en-1|abc|pw"/)
  const parsed = JSON.parse(out)
  expect(parsed.error.name).toBe('Error')
  expect(parsed.error.message).toContain('[REDACTED]')
  expect(parsed.error.token).toBe('[REDACTED]')
})

test('scrubs PEM private keys in free text', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----'
  expect(redact({ note: `key ${pem} end` })).toEqual({
    note: 'key [REDACTED] end',
  })
})

test('bounds string size, depth, fan-out and survives cycles', () => {
  const big = 'a'.repeat(5000)
  expect((redact(big) as string).length).toBeLessThan(600)
  const cyc: Record<string, unknown> = { n: 1 }
  cyc.self = cyc
  expect(redact(cyc)).toEqual({ n: 1, self: '[Circular]' })
  expect(
    (redact(Array.from({ length: 500 }, (_, i) => i)) as number[]).length,
  ).toBe(50)
  let deep: unknown = 'leaf'
  for (let i = 0; i < 20; i++) deep = { d: deep }
  expect(JSON.stringify(redact(deep))).toContain('[MaxDepth]')
})

test('caller fields cannot spoof level or msg', () => {
  const { lines, log } = capture()
  log.info('real', { level: 'fake', msg: 'fake' })
  const parsed = JSON.parse(lines[0]!)
  expect(parsed.level).toBe('info')
  expect(parsed.msg).toBe('real')
})
