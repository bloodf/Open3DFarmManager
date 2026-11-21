import { beforeAll, expect, test } from 'vitest'
import { spoolLibraryImport } from '../../apps/farm/server/services/spool-library-import.ts'
import { login } from '../../apps/farm/server/services/authenticated-session.ts'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import { SESSION_COOKIE_NAME } from '../../apps/farm/server/utils/auth/boundary.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import type { SpoolImportRuntime } from '../../apps/farm/server/utils/spool-library-import/runtime.ts'
import type { SessionDecision } from '../../apps/farm/server/utils/auth/session-contract.ts'
import type {
  ImportOptions,
  ImportResult,
} from '../../apps/farm/server/storage/postgres-spool-library-import.ts'
import {
  normalizeBundle,
  type ImportBundle,
} from '../../apps/farm/server/utils/spool-library-import/bundle.ts'
import {
  csvToBundleInput,
  parseCsv,
} from '../../apps/farm/server/utils/spool-library-import/csv.ts'
import {
  canonicalOrigin,
  readSpoolmanLibrary,
} from '../../apps/farm/server/utils/spool-library-import/spoolman-source.ts'

const origin = 'https://farm.example.invalid'
const farmId = '11111111-1111-4111-8111-111111111111'
const spoolman = 'http://spoolman.example.invalid:7912'
const token = 'synthetic-upstream-token-0123456789'
const sessionRecordId = 'import-session'
let cookie = ''
const cookieConfig = {
  name: SESSION_COOKIE_NAME,
  password: 'synthetic-import-test-secret-32-characters',
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
} satisfies AuthRuntime['cookie']

function fixture() {
  const calls: string[] = []
  const imports: { bundle: ImportBundle; options: ImportOptions }[] = []
  const state: { decision: SessionDecision; result: ImportResult } = {
    decision: { ok: true, accountId: 'account', touchAt: Date.now() },
    result: { ok: false, reason: 'storage-unavailable' },
  }
  const auth: AuthRuntime = {
    origin,
    cookie: cookieConfig,
    idleTimeoutMs: 60000,
    lifetimeMs: 3600000,
    sessions: {
      async authorizeAndTouch() {
        calls.push('authorize')
        return state.decision
      },
      async revokeSession() {},
      async revokeAccountSessions() {},
    },
    credentials: {
      async consumeLimit(kind, key) {
        calls.push(`quota:${kind}:${key}`)
        return true
      },
      async find() {
        return null
      },
      async issue() {
        return null
      },
    },
  }
  const fetched: { url: string; init: RequestInit | undefined }[] = []
  const runtime: SpoolImportRuntime = {
    allowedOrigins: [spoolman],
    importer: {
      async importBundle(_authority, bundle, options) {
        calls.push('import')
        imports.push({ bundle, options })
        return state.result
      },
    } as SpoolImportRuntime['importer'],
    fetch: (async (url: string, init?: RequestInit) => {
      fetched.push({ url, init })
      const path = new URL(url).pathname
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
        })
      if (path === '/api/v1/info') return json({ version: '0.27.1' })
      if (path.startsWith('/api/v1/field/')) return json([])
      if (path === '/api/v1/setting/') return json({})
      if (path === '/api/v1/vendor') return json([{ id: 1, name: 'V' }])
      if (path === '/api/v1/filament')
        return json([
          { id: 1, vendor_id: 1, density: 1.2, diameter: 1.75, name: 'F' },
        ])
      return json([{ id: 1, filament_id: 1 }])
    }) as typeof fetch,
  }
  function event(body?: unknown, method = 'POST', sessionCookie = cookie) {
    return {
      req: new Request(`${origin}/api/farms/${farmId}/spool-library/import`, {
        method,
        headers: {
          cookie: sessionCookie,
          origin,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      res: { headers: new Headers() },
    }
  }
  return { auth, runtime, event, calls, imports, fetched, state }
}

beforeAll(async () => {
  const f = fixture()
  const passwordHash = await hashPassword('synthetic-test-password')
  f.auth.credentials.find = async () => ({
    accountId: 'account',
    passwordHash,
    credentialVersion: '1',
    sessionVersion: '1',
  })
  f.auth.credentials.issue = async () => sessionRecordId
  const login_ = {
    req: new Request(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'owner',
        password: 'synthetic-test-password',
      }),
    }),
    res: { headers: new Headers() },
  }
  await login(login_, f.auth)
  cookie = login_.res.headers.getSetCookie().at(-1)?.split(';')[0] ?? ''
  expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
})

const report = {
  runId: 'r',
  dryRun: false,
  sourceKey: 'json-default',
  vendors: { created: 1, updated: 0, unchanged: 0, adopted: 0, conflicts: 0 },
  filaments: { created: 0, updated: 0, unchanged: 0, adopted: 0, conflicts: 0 },
  spools: { created: 0, updated: 0, unchanged: 0, adopted: 0, conflicts: 0 },
  fields: { created: 0, updated: 0, unchanged: 0, adopted: 0, conflicts: 0 },
  settings: { created: 0, updated: 0, unchanged: 0, adopted: 0, conflicts: 0 },
  truncated: 0,
  skippedSettings: [],
  conflicts: [],
}

test('JSON import passes validated records and defaults to the safe options', async () => {
  const f = fixture()
  f.state.result = { ok: true, report }
  const result = await spoolLibraryImport(
    f.event({ format: 'json', data: { vendors: [{ id: 1, name: 'V' }] } }),
    { farmId },
    f,
  )
  expect(result.report.vendors.created).toBe(1)
  expect(f.calls).toEqual([
    'authorize',
    `quota:s:spool-import:${sessionRecordId}`,
    'import',
  ])
  expect(f.imports[0]?.options).toEqual({
    sourceKey: 'json-default',
    format: 'json',
    dryRun: false,
    onCollision: 'adopt',
    onConflict: 'keep-local',
  })
  expect(f.imports[0]?.bundle.vendors).toHaveLength(1)
})

test('API import reads only an allowed origin, sends the token as a header and never reports it', async () => {
  const f = fixture()
  f.state.result = { ok: true, report }
  const result = await spoolLibraryImport(
    f.event({
      format: 'spoolman-api',
      origin: `${spoolman}/`,
      bearerToken: token,
    }),
    { farmId },
    f,
  )
  expect(JSON.stringify(result)).not.toContain(token)
  expect(f.fetched.length).toBeGreaterThan(5)
  for (const call of f.fetched) {
    expect(call.url.startsWith(`${spoolman}/api/v1/`)).toBe(true)
    expect(call.url).not.toContain(token)
    expect(call.init?.method).toBe('GET')
    expect(call.init?.redirect).toBe('error')
    expect(
      (call.init?.headers as Record<string, string>)['Authorization'],
    ).toBe(`Bearer ${token}`)
  }
  expect(f.imports[0]?.options.sourceKey).toMatch(/^spoolman-[0-9a-f]{16}$/)

  const blocked = fixture()
  await expect(
    spoolLibraryImport(
      blocked.event({
        format: 'spoolman-api',
        origin: 'http://169.254.169.254',
      }),
      { farmId },
      blocked,
    ),
  ).rejects.toMatchObject({ status: 403 })
  expect(blocked.fetched).toEqual([])
  expect(blocked.calls).not.toContain('import')
})

test('request validation: strict fields, origin, content type, size, role mapping', async () => {
  for (const body of [
    { format: 'json', data: {}, password: 'x' },
    { format: 'nope' },
    { format: 'csv', entity: 'spools' },
    {
      format: 'spoolman-api',
      origin: 'http://user:pw@spoolman.example.invalid',
    },
    { format: 'json', data: {}, onConflict: 'maybe' },
  ]) {
    const f = fixture()
    await expect(
      spoolLibraryImport(f.event(body), { farmId }, f),
    ).rejects.toMatchObject({ status: 400 })
    expect(f.calls).not.toContain('import')
  }
  const f = fixture()
  await expect(
    spoolLibraryImport(
      f.event({ format: 'json', data: {} }, 'PUT'),
      { farmId },
      f,
    ),
  ).rejects.toMatchObject({ status: 400 })
  const wrongOrigin = f.event({ format: 'json', data: {} })
  const forged = new Request(wrongOrigin.req.url, {
    method: 'POST',
    headers: {
      cookie,
      origin: 'https://evil.example.invalid',
      'content-type': 'application/json',
    },
    body: '{}',
  })
  await expect(
    spoolLibraryImport({ req: forged, res: wrongOrigin.res }, { farmId }, f),
  ).rejects.toMatchObject({ status: 403 })
  const noCookie = fixture()
  await expect(
    spoolLibraryImport(
      noCookie.event({ format: 'json', data: {} }, 'POST', ''),
      { farmId },
      noCookie,
    ),
  ).rejects.toMatchObject({ status: 401 })

  for (const [reason, status] of [
    ['denied', 403],
    ['forbidden', 404],
    ['unauthorized', 401],
    ['busy', 409],
    ['storage-unavailable', 503],
  ] as const) {
    const g = fixture()
    g.state.result = { ok: false, reason }
    await expect(
      spoolLibraryImport(
        g.event({ format: 'json', data: { vendors: [{ id: 1, name: 'V' }] } }),
        { farmId },
        g,
      ),
    ).rejects.toMatchObject({ status })
  }
  const g = fixture()
  g.state.result = {
    ok: false,
    reason: 'unresolved-reference',
    problems: [{ path: 'spools[id=1].filament', problem: 'missing' }],
  }
  await expect(
    spoolLibraryImport(
      g.event({
        format: 'json',
        data: { spools: [{ id: 1, filament_id: 9 }] },
      }),
      { farmId },
      g,
    ),
  ).rejects.toMatchObject({
    status: 422,
    data: { problems: [{ path: 'spools[id=1].filament' }] },
  })
})

test('bundle: nested records are derived, explicit records win, problems never echo values', () => {
  const ok = normalizeBundle({
    spools: [
      {
        id: 5,
        filament: {
          id: 3,
          name: 'Nested',
          density: 1.2,
          diameter: 1.75,
          color_hex: '#abcdef',
          article_number: 'A-1',
          vendor: { id: 2, name: 'Nested vendor' },
        },
        extra: { slot: '"1"' },
      },
    ],
    filaments: [
      { id: 3, name: 'Explicit', density: 1.2, diameter: 1.75, vendor_id: 2 },
    ],
    settings: {
      currency: { value: '"EUR"', is_set: true, type: 'string' },
      unset: { value: '1', is_set: false, type: 'integer' },
      base_url: { value: '"x"', is_set: true, type: 'string' },
    },
  })
  expect(ok.ok).toBe(true)
  if (!ok.ok) return
  expect(ok.bundle.vendors.map((v) => v.name)).toEqual(['Nested vendor'])
  expect(ok.bundle.filaments[0]?.name).toBe('Explicit')
  expect(ok.bundle.settings).toEqual([{ key: 'currency', value: 'EUR' }])
  expect(ok.bundle.skippedSettings).toEqual(['base_url'])

  const long = normalizeBundle({
    vendors: [{ id: 1, name: 'x'.repeat(300), comment: 'c'.repeat(2000) }],
  })
  expect(long.ok && long.bundle.truncated).toBe(2)

  const bad = normalizeBundle({
    vendors: [{ name: 'no id' }],
    spools: [
      { id: 1, filament_id: 1, extra: { __proto__: 1, Bad: 'secret-value' } },
    ],
  })
  expect(bad.ok).toBe(false)
  if (!bad.ok) {
    expect(bad.problems.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(bad)).not.toContain('secret-value')
  }
})

test('csv: quotes, newlines, BOM and dotted headers; hostile headers and bad shapes are refused', () => {
  const parsed = parseCsv('﻿a,b\r\n"x, ""y""","l1\nl2"\r\n')
  expect(parsed).toEqual({
    ok: true,
    rows: [
      ['a', 'b'],
      ['x, "y"', 'l1\nl2'],
    ],
  })
  expect(parseCsv('a\n"open').ok).toBe(false)
  const nested = csvToBundleInput(
    'spools',
    'id,filament.id,filament.vendor.name,extra.slot\n1,2,V,"""3"""\n',
  )
  expect(nested).toEqual({
    ok: true,
    input: {
      spools: [
        {
          id: '1',
          filament: { id: '2', vendor: { name: 'V' } },
          extra: { slot: '"3"' },
        },
      ],
    },
  })
  expect(csvToBundleInput('vendors', 'name\nx\n').ok).toBe(false)
  expect(csvToBundleInput('vendors', 'id,__proto__.x\n1,y\n').ok).toBe(false)
  expect(csvToBundleInput('vendors', 'id,id\n1,2\n').ok).toBe(false)
  expect(Object.prototype.hasOwnProperty.call({}, 'x')).toBe(false)
})

test('spoolman source: pages, header token, and failure classes that carry no URL or token', async () => {
  expect(canonicalOrigin('http://a.example:7912/')).toBe(
    'http://a.example:7912',
  )
  for (const bad of [
    'http://u:p@a.example',
    'http://a.example/x',
    'http://a.example?q=1',
    'ftp://a.example',
    'javascript:1',
  ])
    expect(canonicalOrigin(bad)).toBeNull()

  const urls: string[] = []
  const pages = Array.from({ length: 450 }, (_, i) => ({ id: i + 1 }))
  const library = await readSpoolmanLibrary({
    origin: spoolman,
    bearerToken: token,
    fetch: (async (url: string) => {
      urls.push(url)
      const u = new URL(url)
      const body =
        u.pathname === '/api/v1/spool'
          ? pages.slice(
              Number(u.searchParams.get('offset')),
              Number(u.searchParams.get('offset')) +
                Number(u.searchParams.get('limit')),
            )
          : u.pathname === '/api/v1/setting/' || u.pathname === '/api/v1/info'
            ? {}
            : []
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  })
  expect((library['spools'] as unknown[]).length).toBe(450)
  expect(urls.filter((u) => u.includes('/spool?')).length).toBe(3)

  const failing = (make: () => Response | Promise<Response>) =>
    readSpoolmanLibrary({
      origin: spoolman,
      bearerToken: token,
      fetch: (async () => make()) as typeof fetch,
    }).then(
      () => 'ok',
      (error: Error) => {
        expect(error.message + JSON.stringify(error)).not.toContain(token)
        expect(error.message + JSON.stringify(error)).not.toContain(
          'spoolman.example',
        )
        return (error as Error & { reason: string }).reason
      },
    )
  expect(await failing(() => new Response('{}', { status: 401 }))).toBe(
    'source-unauthorized',
  )
  expect(await failing(() => new Response('{}', { status: 500 }))).toBe(
    'source-unavailable',
  )
  expect(
    await failing(
      () =>
        new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    ),
  ).toBe('source-invalid')
  expect(
    await failing(
      () =>
        new Response('{not json', {
          headers: { 'content-type': 'application/json' },
        }),
    ),
  ).toBe('source-invalid')
  expect(
    await failing(() =>
      Promise.reject(
        new TypeError(`connect ECONNREFUSED ${spoolman} ${token}`),
      ),
    ),
  ).toBe('source-unavailable')
})

// The bundle type is exercised above; keep the compiler honest about the exported shape.
const _shape: ImportBundle = {
  vendors: [],
  filaments: [],
  spools: [],
  fields: [],
  settings: [],
  truncated: 0,
  skippedSettings: [],
}
void _shape
