import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { build } from 'esbuild'
import {
  compileScript,
  compileTemplate,
  parse as parseSfc,
} from 'vue/compiler-sfc'
import type { Sql } from 'postgres'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import { launchBrowser } from '../helpers/browser.ts'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import { withNetworkGuard } from '../../packages/sim-tools/src/mocks/network-guard.ts'
import {
  printerProfiles,
  type PrinterProfileOperation,
} from '../../apps/farm/server/services/printer-profiles.ts'
import { PostgresPrinterProfiles } from '../../apps/farm/server/storage/postgres-printer-profiles.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'

vi.mock('../../apps/farm/server/services/authenticated-session.ts', () => ({
  authResponse: vi.fn(),
  authenticatedSession: vi.fn(),
  sealedSessionRecordId: () => 'profile-session',
}))

const farmId = '11111111-1111-4111-8111-111111111111'
const agentId = '22222222-2222-4222-8222-222222222222'
const assignmentId = '33333333-3333-4333-8333-333333333333'
const quietId = '44444444-4444-4444-8444-444444444444'
const revokedId = '55555555-5555-4555-8555-555555555555'
const origin = 'https://127.0.0.1'

const detectedState = {
  printerKey: 'moonraker-test',
  state: 'idle',
  progress: 0,
  observedAt: 5,
  machine: {
    model: 'Detectada X1',
    nozzleDiametersMm: [0.4],
    bedSizeMm: { x: 220, y: 220, z: 250 },
    maxHotendCelsius: 260,
  },
}
const editBody = {
  model: 'Mesa do dono',
  nozzleDiameterMm: 0.6,
  bedSizeXMm: null,
  bedSizeYMm: null,
  bedSizeZMm: null,
  maxHotendTemperatureCelsius: null,
  maxBedTemperatureCelsius: 110,
  kinematics: null,
  compatibleModels: ['Modelo A', 'Modelo B'],
  notes: 'Bico de latão',
}

type Stored = {
  model: string | null
  nozzleDiameterMm: number | null
  bedSizeXMm: number | null
  bedSizeYMm: number | null
  bedSizeZMm: number | null
  maxHotendTemperatureCelsius: number | null
  maxBedTemperatureCelsius: number | null
  kinematics: string | null
  compatibleModels: string[]
  notes: string | null
  updatedBy: string
  updatedAt: number
}

/** In-process Postgres stand-in that understands only the statements the store sends. */
function fixture(
  role: string | null,
  options: { failSql?: boolean; consume?: boolean } = {},
) {
  const profiles = new Map<string, Stored>()
  const writes: unknown[][] = []
  const active = [assignmentId, quietId]
  const rows = (
    id: string | null,
    after: string | null,
    limit: number,
  ): unknown[] =>
    active
      .filter((a) => (id === null || a === id) && (after === null || a > after))
      .slice(0, limit)
      .map((a) => {
        const stored = profiles.get(a)
        return {
          assignmentId: a,
          state: a === assignmentId ? detectedState : null,
          profileAssignmentId: stored ? a : null,
          model: stored?.model ?? null,
          nozzleDiameterMm: stored?.nozzleDiameterMm ?? null,
          bedSizeXMm: stored?.bedSizeXMm ?? null,
          bedSizeYMm: stored?.bedSizeYMm ?? null,
          bedSizeZMm: stored?.bedSizeZMm ?? null,
          maxHotendTemperatureCelsius:
            stored?.maxHotendTemperatureCelsius ?? null,
          maxBedTemperatureCelsius: stored?.maxBedTemperatureCelsius ?? null,
          kinematics: stored?.kinematics ?? null,
          compatibleModels: stored?.compatibleModels ?? null,
          notes: stored?.notes ?? null,
          updatedBy: stored?.updatedBy ?? null,
          updatedAt: stored?.updatedAt ?? null,
        }
      })
  const tx = async (parts: TemplateStringsArray, ...args: unknown[]) => {
    if (options.failSql) throw new Error('database unavailable')
    const statement = parts.join('?').trim()
    if (statement.includes('FROM farm.session_accounts'))
      return [{ id: 'account', sessionVersion: 0, disabled: false }]
    if (statement.includes('FROM farm.account_sessions'))
      return [
        {
          id: 'profile-session',
          accountId: 'account',
          accountVersion: 0,
          createdAt: 0,
          lastSeenAt: 10,
          absoluteExpiresAt: 1000,
          revokedAt: null,
        },
      ]
    if (statement.includes('FROM farm.memberships')) {
      expect(args[0]).toBe(farmId)
      return role ? [{ role, revoked_at: null }] : []
    }
    if (statement.startsWith('SELECT id FROM farm.printer_assignments'))
      expect(statement).toContain('revoked_at IS NULL')
    if (statement.startsWith('SELECT id FROM farm.printer_assignments'))
      return args[1] !== undefined && active.includes(String(args[1]))
        ? [{ id: args[1] }]
        : []
    if (statement.includes('FROM farm.printer_assignments a LEFT JOIN')) {
      expect(args[0]).toBe(farmId)
      expect(statement).toContain('a.revoked_at IS NULL')
      return rows(
        (args[1] as string | null) ?? null,
        (args[3] as string | null) ?? null,
        Number(args[5]),
      )
    }
    if (statement.startsWith('INSERT INTO farm.printer_profiles')) {
      writes.push(args)
      const [id, , model, nozzle, x, y, z, hotend, bed, kinematics, json] = args
      profiles.set(String(id), {
        model: model as string | null,
        nozzleDiameterMm: nozzle as number | null,
        bedSizeXMm: x as number | null,
        bedSizeYMm: y as number | null,
        bedSizeZMm: z as number | null,
        maxHotendTemperatureCelsius: hotend as number | null,
        maxBedTemperatureCelsius: bed as number | null,
        kinematics: kinematics as string | null,
        compatibleModels: JSON.parse(String(json)) as string[],
        notes: args[11] as string | null,
        updatedBy: String(args[12]),
        updatedAt: Number(args[13]),
      })
    }
    return []
  }
  const sql = {
    begin: (action: (sql: unknown) => unknown) => action(tx),
  } as unknown as Sql
  const consume = vi.fn(async () => options.consume ?? true)
  const auth = {
    origin,
    idleTimeoutMs: 100,
    credentials: { consumeLimit: consume },
  } as unknown as AuthRuntime
  const runtime = { profiles: new PostgresPrinterProfiles(sql, () => 20) }
  const call = (
    operation: PrinterProfileOperation,
    init: {
      method?: string
      body?: unknown
      origin?: string
      headers?: Record<string, string>
      id?: string
      url?: string
    } = {},
  ) => {
    const method = init.method ?? (operation === 'edit' ? 'PUT' : 'GET')
    const body =
      init.body === undefined
        ? undefined
        : typeof init.body === 'string'
          ? init.body
          : JSON.stringify(init.body)
    return withNetworkGuard(() =>
      printerProfiles(
        {
          req: new Request(init.url ?? origin + '/profile', {
            method,
            headers: {
              ...(method === 'PUT'
                ? {
                    origin: init.origin ?? origin,
                    'content-type': 'application/json',
                  }
                : {}),
              ...init.headers,
            },
            ...(body !== undefined && { body }),
          }),
          res: { headers: new Headers() },
        } as Parameters<typeof printerProfiles>[0],
        operation,
        { farmId, assignmentId: init.id ?? assignmentId },
        { auth, runtime },
      ),
    )
  }
  return {
    call,
    writes,
    profiles,
    consume,
    auth,
    runtime,
  }
}

describe('profile read', () => {
  test.each(['owner', 'admin', 'operator', 'viewer'])(
    '%s reads detected, override and effective values',
    async (role) => {
      const route = fixture(role)
      const result = (await route.call('read')) as {
        profile: Record<string, any>
        canManage: boolean
      }
      expect(result.canManage).toBe(role === 'owner' || role === 'admin')
      expect(result.profile.assignmentId).toBe(assignmentId)
      expect(result.profile.detected).toMatchObject({
        model: 'Detectada X1',
        nozzleDiameterMm: 0.4,
        bedSizeXMm: 220,
        maxHotendTemperatureCelsius: 260,
      })
      expect(result.profile.override.model).toBeNull()
      expect(result.profile.effective.sources.model).toBe('detected')
      expect(result.profile.effective.values.model).toBe('Detectada X1')
      expect(result.profile.updatedAt).toBeNull()
    },
  )

  test('serves the override over the detected value after an edit', async () => {
    const route = fixture('owner')
    await route.call('edit', { body: editBody })
    const { profile } = (await route.call('read')) as {
      profile: Record<string, any>
    }
    expect(profile.override.model).toBe('Mesa do dono')
    expect(profile.detected.model).toBe('Detectada X1')
    expect(profile.effective.values).toMatchObject({
      model: 'Mesa do dono',
      nozzleDiameterMm: 0.6,
      bedSizeXMm: 220,
      maxBedTemperatureCelsius: 110,
    })
    expect(profile.effective.sources).toMatchObject({
      model: 'override',
      bedSizeXMm: 'detected',
      kinematics: 'unknown',
    })
    expect(profile.effective.compatibleModels).toEqual(['Modelo A', 'Modelo B'])
    expect(profile.effective.notes).toBe('Bico de latão')
    expect(profile.updatedAt).toBe(20)
  })

  test('only managers see which account last edited the profile', async () => {
    const owner = fixture('owner')
    await owner.call('edit', { body: editBody })
    const seenByOwner = (await owner.call('read')) as { profile: any }
    expect(seenByOwner.profile.updatedBy).toBe('account')
    const operator = fixture('operator')
    operator.profiles.set(assignmentId, {
      ...(owner.profiles.get(assignmentId) as Stored),
    })
    const seenByOperator = (await operator.call('read')) as { profile: any }
    expect(seenByOperator.profile.updatedBy).toBeNull()
    expect(seenByOperator.profile.effective.values.model).toBe('Mesa do dono')
  })

  test('a printer without a detected state still returns an empty profile', async () => {
    const { profile } = (await fixture('viewer').call('read', {
      id: quietId,
    })) as { profile: any }
    expect(profile.effective.values.model).toBeNull()
    expect(profile.effective.sources.model).toBe('unknown')
  })

  test('revoked, foreign and malformed assignments are not found', async () => {
    const route = fixture('owner')
    await expect(route.call('read', { id: revokedId })).rejects.toMatchObject({
      status: 404,
    })
    await expect(
      route.call('read', { id: 'not-a-uuid' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  test('a non-member learns nothing about the farm', async () => {
    await expect(fixture(null).call('read')).rejects.toMatchObject({
      status: 404,
    })
    await expect(fixture(null).call('list')).rejects.toMatchObject({
      status: 404,
    })
  })

  test('only GET reads and storage failures are reported', async () => {
    await expect(
      fixture('owner').call('read', { method: 'POST', body: '{}' }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      fixture('owner', { failSql: true }).call('read'),
    ).rejects.toMatchObject({ status: 503 })
  })

  test('rate limiting is applied per session and operation', async () => {
    const route = fixture('owner', { consume: false })
    await expect(route.call('read')).rejects.toMatchObject({ status: 429 })
    expect(route.consume).toHaveBeenCalledWith(
      's',
      'printer-profiles:read:profile-session',
    )
  })

  test('lists effective profiles for the library and replay pages with paging', async () => {
    const route = fixture('operator')
    const first = (await route.call('list', {
      url: origin + '/printer-profiles?limit=1',
    })) as { profiles: any[]; nextAfter: string | null; canManage: boolean }
    expect(first.canManage).toBe(false)
    expect(first.profiles).toHaveLength(1)
    expect(first.profiles[0].assignmentId).toBe(assignmentId)
    expect(first.profiles[0].effective.values.model).toBe('Detectada X1')
    expect(first.nextAfter).toBe(assignmentId)
    const second = (await route.call('list', {
      url: origin + '/printer-profiles?limit=1&after=' + first.nextAfter,
    })) as { profiles: any[]; nextAfter: string | null }
    expect(second.profiles.map((p) => p.assignmentId)).toEqual([quietId])
    expect(second.nextAfter).toBeNull()
  })
})

describe('profile edit and roles', () => {
  test.each(['owner', 'admin'])('%s saves the override', async (role) => {
    const route = fixture(role)
    const result = (await route.call('edit', { body: editBody })) as {
      profile: any
      canManage: boolean
    }
    expect(result.canManage).toBe(true)
    expect(result.profile.effective.values.model).toBe('Mesa do dono')
    expect(route.writes).toHaveLength(1)
    expect(route.writes[0]).toEqual([
      assignmentId,
      farmId,
      'Mesa do dono',
      0.6,
      null,
      null,
      null,
      null,
      110,
      null,
      JSON.stringify(['Modelo A', 'Modelo B']),
      'Bico de latão',
      'account',
      20,
    ])
  })

  test('clearing every field removes the override and falls back to detected', async () => {
    const route = fixture('owner')
    await route.call('edit', { body: editBody })
    const cleared = Object.fromEntries(
      Object.keys(editBody).map((key) => [
        key,
        key === 'compatibleModels' ? [] : null,
      ]),
    )
    const { profile } = (await route.call('edit', { body: cleared })) as {
      profile: any
    }
    expect(profile.effective.values.model).toBe('Detectada X1')
    expect(profile.effective.sources.model).toBe('detected')
  })

  test.each(['operator', 'viewer'])('%s cannot edit', async (role) => {
    const route = fixture(role)
    await expect(route.call('edit', { body: editBody })).rejects.toMatchObject({
      status: 403,
    })
    expect(route.writes).toHaveLength(0)
  })

  test('a non-member cannot edit and nothing is written', async () => {
    const route = fixture(null)
    await expect(route.call('edit', { body: editBody })).rejects.toMatchObject({
      status: 404,
    })
    expect(route.writes).toHaveLength(0)
  })

  test('a revoked assignment cannot be edited', async () => {
    const route = fixture('owner')
    await expect(
      route.call('edit', { body: editBody, id: revokedId }),
    ).rejects.toMatchObject({ status: 404 })
    expect(route.writes).toHaveLength(0)
  })

  test('rejects a foreign origin, wrong media type and oversized payloads', async () => {
    const route = fixture('owner')
    await expect(
      route.call('edit', { body: editBody, origin: 'https://other.invalid' }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      route.call('edit', {
        body: editBody,
        headers: { 'content-type': 'text/plain' },
      }),
    ).rejects.toMatchObject({ status: 415 })
    await expect(
      route.call('edit', {
        body: editBody,
        headers: { 'content-length': '8193' },
      }),
    ).rejects.toMatchObject({ status: 413 })
    await expect(
      route.call('edit', { body: ' '.repeat(8200) }),
    ).rejects.toMatchObject({ status: 413 })
    await expect(
      route.call('edit', { body: editBody, method: 'POST' }),
    ).rejects.toMatchObject({ status: 400 })
    expect(route.writes).toHaveLength(0)
  })

  test.each([
    ['malformed JSON', '{'],
    ['duplicate keys', '{"model":"a","model":"b"}'],
    ['unknown field', { ...editBody, role: 'owner' }],
    ['missing field', { ...editBody, notes: undefined }],
    ['negative nozzle', { ...editBody, nozzleDiameterMm: -0.4 }],
    ['text number', { ...editBody, bedSizeXMm: '220' }],
    ['too many models', { ...editBody, compatibleModels: Array(17).fill('a') }],
    ['control character', { ...editBody, notes: 'a\u0007b' }],
  ])('rejects %s without writing', async (_name, body) => {
    const route = fixture('owner')
    await expect(route.call('edit', { body })).rejects.toMatchObject({
      status: 400,
    })
    expect(route.writes).toHaveLength(0)
  })

  test('removes duplicate compatible models before storing', async () => {
    const route = fixture('owner')
    await route.call('edit', {
      body: { ...editBody, compatibleModels: ['B', 'A', 'B'] },
    })
    expect(route.writes[0]?.[10]).toBe(JSON.stringify(['B', 'A']))
  })
})

describe('wiring', () => {
  const read = (path: string) =>
    readFileSync(new URL('../../' + path, import.meta.url), 'utf8')

  test('exposes read, edit and list routes through the profile service', () => {
    const base = 'apps/farm/server/api/farms/[farmId]/'
    expect(read(base + 'printers/[assignmentId]/profile.get.ts')).toContain(
      "'read'",
    )
    expect(read(base + 'printers/[assignmentId]/profile.put.ts')).toContain(
      "'edit'",
    )
    expect(read(base + 'printer-profiles.get.ts')).toContain("'list'")
  })

  test('migration adds the per-assignment table and rolls it back', () => {
    const up = read('infra/db/migrations/0065_printer_profiles.up.sql')
    const down = read('infra/db/migrations/0065_printer_profiles.down.sql')
    expect(up).toContain(
      'assignment_id uuid PRIMARY KEY REFERENCES farm.printer_assignments(id)',
    )
    for (const column of [
      'compatible_models text[]',
      'notes text',
      'updated_by text NOT NULL REFERENCES farm.session_accounts(id)',
      'updated_at bigint NOT NULL',
    ])
      expect(up).toContain(column)
    expect(up).not.toMatch(/GRANT (ALL|DELETE|TRUNCATE)/)
    expect(down).toContain('DROP TABLE farm.printer_profiles')
    expect(down).toContain('REVOKE SELECT ON farm.printer_latest_state')
  })

  test('the runtime role policy accounts for the profile table grants', () => {
    const policy = read(
      'apps/farm/server/utils/printer-assignments/role-policy.ts',
    )
    expect(policy).toContain("'printer_profiles'")
    expect(policy).toContain("'farm.printer_profiles','INSERT'")
    expect(policy.split('(').length).toBe(policy.split(')').length)
  })
})

describe('machine profile panel', { timeout: 30_000 }, () => {
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let server: Awaited<ReturnType<typeof startHttpMock>> | undefined
  let page: Page
  let route: ReturnType<typeof fixture>
  let apiCalls: string[]

  const html = `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Perfil da máquina</title>
<main>
  <h1>Impressoras</h1>
  <h2>Atribuições</h2>
  <div id="app"></div>
</main>
<script src="/panel.js" defer></script>
</html>`

  beforeAll(async () => {
    const bundle = await build({
      stdin: {
        contents: `
          import { createApp } from 'vue'
          import MachineProfile from './apps/farm/app/components/machine-profile/MachineProfile.vue'
          globalThis.$fetch = async (url, options = {}) => {
            const response = await fetch(url, {
              method: options.method ?? 'GET',
              credentials: 'same-origin',
              signal: options.signal,
              headers: options.body ? { 'content-type': 'application/json' } : {},
              body: options.body ? JSON.stringify(options.body) : undefined,
            })
            if (!response.ok)
              throw Object.assign(new Error('http'), { status: response.status })
            return response.json()
          }
          const params = new URLSearchParams(location.search)
          createApp(MachineProfile, {
            farmId: ${JSON.stringify(farmId)},
            assignmentId: ${JSON.stringify(assignmentId)},
            label: 'Mesa 1',
            canManage: params.get('manage') === '1',
          }).mount('#app')
        `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      outfile: 'panel.js',
      plugins: [
        {
          name: 'panel-vue',
          setup(builder) {
            builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
              const { descriptor, errors } = parseSfc(
                await readFile(path, 'utf8'),
                { filename: path },
              )
              if (errors.length) throw new Error(errors.join('\n'))
              const id = `data-v-${basename(path, '.vue')}`
              const code = descriptor.scriptSetup
                ? compileScript(descriptor, {
                    id,
                    inlineTemplate: true,
                    genDefaultAs: 'component',
                  }).content
                : `${
                    compileTemplate({
                      filename: path,
                      id,
                      source: descriptor.template?.content ?? '',
                    }).code
                  }\nconst component = { render }`
              return {
                loader: 'ts',
                resolveDir: dirname(path),
                contents: `${code}\nexport default component`,
              }
            })
          },
        },
      ],
    })
    const script = bundle.outputFiles[0]
    if (!script) throw new Error('Missing panel bundle')
    server = await startHttpMock({
      port: 0,
      handler: async (request, response, body) => {
        const url = new URL(request.url ?? '/', server?.origin)
        if (url.pathname === '/panel') {
          response.setHeader('content-type', 'text/html; charset=utf-8')
          return void response.end(html)
        }
        if (url.pathname === '/panel.js') {
          response.setHeader('content-type', 'text/javascript; charset=utf-8')
          return void response.end(script.text)
        }
        apiCalls.push(`${request.method} ${url.pathname}`)
        const operation =
          request.method === 'PUT'
            ? 'edit'
            : ('read' as PrinterProfileOperation)
        try {
          const headers = new Headers()
          for (const [name, value] of Object.entries(request.headers))
            if (typeof value === 'string') headers.set(name, value)
          // The auth boundary only trusts https; this stands in for TLS termination.
          if (headers.get('origin') === server?.origin)
            headers.set('origin', origin)
          const result = await printerProfiles(
            {
              req: new Request(url, {
                method: request.method ?? 'GET',
                headers,
                body: request.method === 'PUT' ? new Uint8Array(body) : null,
              }),
              res: { headers: new Headers() },
            } as Parameters<typeof printerProfiles>[0],
            operation,
            { farmId, assignmentId },
            { auth: route.auth, runtime: route.runtime },
          )
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(result))
        } catch (error) {
          const status =
            (error as { status?: number }).status ??
            (error as { statusCode?: number }).statusCode ??
            500
          response.statusCode = status
          response.end(JSON.stringify({ status }))
        }
      },
    })
    // Playwright's own launch cap is 30s and matches this hook, so a cold
    // Chrome on a busy Node 22 runner fails the hook before the panel renders.
    browser = await launchBrowser({
      timeout: 90_000,
      args: ['--disable-background-networking', '--disable-dev-shm-usage'],
    })
  }, 120_000)

  afterAll(async () => {
    try {
      await Promise.race([
        browser?.close(),
        new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
      ])
    } finally {
      await server?.close()
    }
  })

  // The first context starts Chrome's renderer. Give harness setup its own
  // deadline so a cold browser does not consume the interaction test budget.
  beforeEach(async () => {
    apiCalls = []
    if (!browser || !server) throw new Error('Panel fixture unavailable')
    context = await browser.newContext({
      viewport: { width: 375, height: 800 },
    })
    const base = server.origin
    await context.route('**/*', (request) =>
      new URL(request.request().url()).origin === base
        ? request.continue()
        : request.abort(),
    )
    page = await context.newPage()
  }, 30_000)

  afterEach(async () => {
    await context?.close()
    context = undefined
  })

  async function open(role: string) {
    if (!server) throw new Error('Panel fixture unavailable')
    route = fixture(role)
    const manage = role === 'owner' || role === 'admin' ? '1' : '0'
    await page.goto(`${server.origin}/panel?manage=${manage}`)
    await page
      .getByRole('heading', { name: 'Perfil da máquina de Mesa 1' })
      .waitFor()
  }

  test('loads lazily, then shows detected, override and effective values', async () => {
    await open('operator')
    expect(apiCalls).toEqual([])
    const toggle = page.getByRole('button', { name: 'Ver perfil da máquina' })
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    await toggle.click()
    const table = page.getByRole('table', {
      name: 'Valores detectados e definidos pelo proprietário',
    })
    await table.waitFor()
    expect(apiCalls).toEqual([
      `GET /api/farms/${farmId}/printers/${assignmentId}/profile`,
    ])
    const row = table.getByRole('row', { name: /^Modelo / })
    expect(await row.innerText()).toContain('Detectada X1')
    expect(await row.innerText()).toContain('Detectado')
    expect(
      await page
        .getByRole('button', { name: 'Ocultar perfil da máquina' })
        .getAttribute('aria-expanded'),
    ).toBe('true')
  })

  test('operators see the profile but have no edit control', async () => {
    await open('operator')
    await page.getByRole('button', { name: 'Ver perfil da máquina' }).click()
    await page.getByRole('table').waitFor()
    expect(
      await page.getByRole('button', { name: /Editar perfil/ }).count(),
    ).toBe(0)
    await page
      .getByText('Somente proprietários e administradores podem editar')
      .waitFor()
    // The server refuses a direct write even when the control is bypassed.
    const status = await page.evaluate(
      async ({ farm, assignment, body }) =>
        (
          await fetch(`/api/farms/${farm}/printers/${assignment}/profile`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status,
      { farm: farmId, assignment: assignmentId, body: editBody },
    )
    expect(status).toBe(403)
    expect(route.writes).toHaveLength(0)
  })

  test('an owner edits the override and the effective value updates', async () => {
    await open('owner')
    await page.getByRole('button', { name: 'Ver perfil da máquina' }).click()
    await page.getByRole('table').waitFor()
    await page
      .getByRole('button', { name: 'Editar perfil da máquina de Mesa 1' })
      .click()
    await page.getByLabel('Modelo', { exact: true }).fill('Mesa do dono')
    await page.getByLabel('Diâmetro do bico (mm)').fill('0,6')
    await page.getByLabel('Modelos compatíveis (um por linha)').fill('A\nB')
    await page.getByLabel('Observações').fill('Bico de latão')
    await page.getByRole('button', { name: 'Salvar perfil da máquina' }).click()
    await page.getByText('Perfil da máquina salvo.').waitFor()
    const row = page.getByRole('row', { name: /^Modelo / })
    expect(await row.innerText()).toContain('Mesa do dono')
    expect(await row.innerText()).toContain('Definido pelo proprietário')
    expect(route.writes).toHaveLength(1)
    expect(route.writes[0]?.slice(2, 4)).toEqual(['Mesa do dono', 0.6])
    expect(route.writes[0]?.[10]).toBe(JSON.stringify(['A', 'B']))
  })

  test('invalid numbers are reported without sending a request', async () => {
    await open('admin')
    await page.getByRole('button', { name: 'Ver perfil da máquina' }).click()
    await page.getByRole('table').waitFor()
    await page.getByRole('button', { name: /Editar perfil/ }).click()
    await page.getByLabel('Diâmetro do bico (mm)').fill('-1')
    await page.getByRole('button', { name: 'Salvar perfil da máquina' }).click()
    await page.getByRole('alert').waitFor()
    expect(await page.getByRole('alert').textContent()).toContain(
      'Diâmetro do bico (mm)',
    )
    expect(apiCalls.filter((call) => call.startsWith('PUT'))).toEqual([])
  })

  test('passes axe collapsed, expanded and while editing', async () => {
    await open('owner')
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: 'Ver perfil da máquina' }).click()
    await page.getByRole('table').waitFor()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: /Editar perfil/ }).click()
    await page.getByRole('group', { name: /Valores do proprietário/ }).waitFor()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.getByLabel('Diâmetro do bico (mm)').fill('abc')
    await page.getByRole('button', { name: 'Salvar perfil da máquina' }).click()
    await page.getByRole('alert').waitFor()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  }, 60_000)

  test('can be driven by keyboard alone', async () => {
    await open('owner')
    await page.getByRole('button', { name: 'Ver perfil da máquina' }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('table').waitFor()
    await page.keyboard.press('Tab')
    expect(
      await page.evaluate(() => document.activeElement?.textContent?.trim()),
    ).toBe('Editar perfil da máquina de Mesa 1')
  })
})
