import { test, expect, vi } from 'vitest'
import { logUnhandledError } from '../../apps/farm/server/utils/log-unhandled-error.ts'
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
  expect(parsed.error.token).toBeUndefined()
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
  for (let i = 0; i < 20; i++) deep = { next: deep }
  expect(JSON.stringify(redact(deep))).toContain('[MaxDepth]')
})

test('caller fields cannot spoof level or msg', () => {
  const { lines, log } = capture()
  log.info('real', { level: 'fake', msg: 'fake' })
  const parsed = JSON.parse(lines[0]!)
  expect(parsed.level).toBe('info')
  expect(parsed.msg).toBe('real')
})

test('scrubs URL userinfo, query params, free text, JWTs; keeps Bearer/PEM scrubbing', () => {
  const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.c2ln'
  const out = redact({
    one: 'connect postgres://user:pass@db:5432/x failed',
    two: 'GET /cb?state=ok&access_token=abc123&user_code=WXYZ&x=1',
    three: 'password=hunter2 and secret: "top secret" end',
    four: `jwt ${jwt}`,
    five: 'Authorization: Basic setup',
    six: 'Basic dXNlcjpwYXNzd29yZA==',
  }) as Record<string, string>
  expect(out.one).toBe('connect postgres://[REDACTED]@db:5432/x failed')
  expect(out.two).toBe(
    'GET /cb?state=ok&access_token=[REDACTED]&user_code=[REDACTED]&x=1',
  )
  expect(out.three).toBe('password=[REDACTED] and secret: [REDACTED] end')
  expect(out.four).toBe('jwt [REDACTED]')
  expect(out.five).toBe('Authorization: [REDACTED]')
  expect(out.six).toBe('[REDACTED]')
  expect(redact('Basic setup')).toBe('Basic setup')
})

test('bounds input before regex and truncates after', () => {
  const out = redact('x'.repeat(5_000_000)) as string
  expect(out.length).toBeLessThan(600)
})

test('redacts the repo real field names and private JWK members', () => {
  const out = redact({
    user_code: 'ABCD-1234',
    admission_nonce: 'n',
    challenge_id: 'public-id',
    sessionRecordId: 's',
    signingKeyId: 'k1',
    sig: 'x',
    jwk: { kty: 'EC', crv: 'P-256', x: 'pub', d: 'priv', k: 'sym', qi: 'q' },
    salt: 's',
    verifier: 'v',
    otp: '1',
    pwd: 'p',
    csrf: 'c',
    hmac: 'h',
    jwt: 'j',
    databaseUrl: 'postgres://u:p@h/db',
    DATABASE_URL: 'u',
    dsn: 'd',
    connectionString: 'c',
    seed: 'x',
    mnemonic: 'm',
    footprint: 'keep',
  }) as Record<string, any>
  const redacted = Object.entries(out)
    .filter(([, v]) => v === '[REDACTED]')
    .map(([k]) => k)
  expect(
    Object.keys(out)
      .filter((k) => !redacted.includes(k))
      .sort(),
  ).toEqual(['challenge_id', 'footprint', 'jwk'])
  expect(out.jwk).toEqual({
    kty: 'EC',
    crv: 'P-256',
    x: 'pub',
    d: '[REDACTED]',
    k: '[REDACTED]',
    qi: '[REDACTED]',
  })
})

test('errors log an allowlist only and never spread own props', () => {
  const err = Object.assign(new Error('bad'), {
    code: 'E_X',
    statusCode: 500,
    detail: 'password',
    where: 'w',
    query: 'q',
    parameters: ['p'],
    data: 'd',
    response: { x: 1 },
    request: { x: 1 },
    config: { x: 1 },
    body: 'b',
    other: 'o',
  })
  const out = redact(err) as Record<string, unknown>
  expect(Object.keys(out).sort()).toEqual([
    'code',
    'message',
    'name',
    'stack',
    'statusCode',
  ])
  const agg = redact(
    new AggregateError(
      Array.from({ length: 30 }, () => new Error('e')),
      'a',
    ),
  ) as {
    errors: unknown[]
  }
  expect(agg.errors).toHaveLength(10)
})

test('global node budget bounds huge object graphs', () => {
  const wide = Array.from({ length: 50 }, () =>
    Array.from({ length: 50 }, () =>
      Array.from({ length: 50 }, () => ({ a: { b: 1 } })),
    ),
  )
  expect(JSON.stringify(redact(wide))).toContain('[Budget]')
  const huge: Record<string, number> = {}
  for (let i = 0; i < 100_000; i++) huge[`k${i}`] = i
  expect(Object.keys(redact(huge) as object)).toHaveLength(50)
})

test('binary, dates, maps, sets, getters, toJSON, proxies and null-proto output', () => {
  let called = false
  const evil = {
    get secretish() {
      called = true
      return 'x'
    },
    toJSON() {
      called = true
      return 'boom'
    },
    ok: 1,
  }
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('trap')
      },
    },
  )
  const out = redact({
    buf: Buffer.from('abc'),
    ab: new ArrayBuffer(8),
    ta: new Uint8Array(4),
    date: new Date('2026-01-01T00:00:00Z'),
    map: new Map([[1, 2]]),
    set: new Set([1, 2]),
    evil,
    proxy,
    ['__proto__']: 'x',
  }) as Record<string, unknown>
  expect(out).toMatchObject({
    buf: '[Binary 3B]',
    ab: '[Binary 8B]',
    ta: '[Binary 4B]',
    date: '2026-01-01T00:00:00.000Z',
    map: '[Map 1]',
    set: '[Set 2]',
    proxy: '[Unreadable]',
  })
  expect((out.evil as Record<string, unknown>).secretish).toBe('[REDACTED]')
  expect(called).toBe(false)
  expect(Object.getPrototypeOf(out)).toBeNull()
})

test('logger never throws, even when write or fields blow up', () => {
  const lines: string[] = []
  let n = 0
  const log = createLogger('x', (l) => {
    if (n++ === 0) throw new Error('disk')
    lines.push(l)
  })
  expect(() => log.error('m', { a: 1 })).not.toThrow()
  expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['log-failed'])
  const quiet = createLogger('x', () => {
    throw new Error('always')
  })
  expect(() => quiet.info('m')).not.toThrow()
})

test('unhandled-error hook logs 5xx path only and never throws', () => {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  logUnhandledError(Object.assign(new Error('x'), { statusCode: 500 }), {
    path: '/api/x?token=abc',
  })
  logUnhandledError(Object.assign(new Error('x'), { statusCode: 404 }), {
    path: '/n',
  })
  logUnhandledError(new Error('no status'), undefined)
  const out = spy.mock.calls.map((c) => String(c[0]))
  spy.mockRestore()
  expect(out).toHaveLength(2)
  expect(out[0]).toContain('"path":"/api/x"')
  expect(out.join('')).not.toContain('abc')
  expect(() => logUnhandledError(null, null as never)).not.toThrow()
})

test('Authorization/Proxy-Authorization schemes are redacted as one value', () => {
  const s = (v: string) => redact(v) as string
  for (const text of [
    'Authorization: Bearer tok123.abc',
    'Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'authorization=Bearer tok123',
    'Authorization: Basic setup',
  ]) {
    expect(s(text)).toMatch(/^[A-Za-z-]+[:=] ?\[REDACTED\]$/)
  }
  expect(s('Authorization: Bearer tok123')).not.toContain('tok123')
})

test('quoted JSON/JS object text is scrubbed', () => {
  const s = (v: string) => redact(v) as string
  expect(s('{"password":"hunter2"}')).not.toContain('hunter2')
  expect(s('{"apiKey":"K1"}')).not.toContain('K1')
  expect(s("{'token':'abc'}")).not.toContain('abc')
  expect(s('{"password": "a b c", "ok": "yes"}')).toBe(
    '{"password": [REDACTED], "ok": "yes"}',
  )
  expect(s('{"pw":"x1","sid":"x2"}')).not.toMatch(/x1|x2/)
  expect(s('side: left')).toBe('side: left')
})

test('Cookie and Set-Cookie redact the whole header value', () => {
  const out = redact(
    'Cookie: a=1; b=2; c=3\nSet-Cookie: sid=zz; HttpOnly\nnext: line',
  ) as string
  expect(out).toBe('Cookie: [REDACTED]\nSet-Cookie: [REDACTED]\nnext: line')
})

test('extra query keys and userinfo with raw @', () => {
  const out = redact('/x?sid=1&pw=2&otp=3&jwt=4&auth=5&keep=6') as string
  expect(out).toBe(
    '/x?sid=[REDACTED]&pw=[REDACTED]&otp=[REDACTED]&jwt=[REDACTED]&auth=[REDACTED]&keep=6',
  )
  expect(redact('postgres://u:p@ss@host:5432/db')).toBe(
    'postgres://[REDACTED]@host:5432/db',
  )
})

test('extra object keys are redacted', () => {
  const out = redact({
    auth: 'a',
    bearer: 'b',
    credential: 'c',
    creds: 'c',
    sid: 's',
    accessKey: 'x',
    encryptionKey: 'x',
    masterKey: 'x',
    pin: '1',
    key: 'k',
    api_key: 'k',
    author: 'keep',
    pinned: 'keep',
  }) as Record<string, string>
  expect(Object.keys(out).filter((k) => out[k] !== '[REDACTED]')).toEqual([
    'author',
    'pinned',
  ])
})

test('1 MB hostile inputs scrub in linear time', () => {
  const inputs = [
    'x'.repeat(1_000_000),
    'a.'.repeat(500_000),
    '"'.repeat(1_000_000),
    'password'.repeat(125_000),
    'Bearer '.repeat(140_000),
    '://@'.repeat(250_000),
    '?a='.repeat(333_333),
  ]
  const start = Date.now()
  for (const input of inputs) redact(input)
  expect(Date.now() - start).toBeLessThan(2000)
})

test('hook honors status as well as statusCode', () => {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  logUnhandledError(Object.assign(new Error('x'), { status: 400 }), {
    path: '/n',
  })
  const n = spy.mock.calls.length
  spy.mockRestore()
  expect(n).toBe(0)
})

test('Authorization with any scheme is redacted to end of value', () => {
  const s = (v: string) => redact(v) as string
  for (const text of [
    'Authorization: Token abc123',
    'authorization: ApiKey abc123',
    'Authorization: AWS4-HMAC-SHA256 Credential=AKIA/2026/x, Signature=abc123',
    'Proxy-Authorization: Digest username="u", response="abc123"',
  ]) {
    expect(s(text)).not.toContain('abc123')
    expect(s(text)).not.toMatch(/AKIA|"u"/)
  }
  expect(s('{"authorization":"Token abc123"}')).not.toContain('abc123')
})

test('escaped quotes inside quoted values do not end redaction early', () => {
  const out = redact('{"password":"ab\\"cd-LEAK","x":"ok"}') as string
  expect(out).not.toContain('LEAK')
  expect(out).toContain('"x":"ok"')
  expect(redact("{'token':'ab\\'cd-LEAK'}")).not.toContain('LEAK')
})

test('authenticated boolean stays visible, auth is redacted', () => {
  expect(redact({ authenticated: true, auth: 'x' })).toEqual({
    authenticated: true,
    auth: '[REDACTED]',
  })
})
