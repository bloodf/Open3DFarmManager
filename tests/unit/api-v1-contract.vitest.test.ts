// Contract test: every path and status code in docs/api/openapi-v1.yaml is
// exercised against the real v1 route files, the real authorizing middleware
// and the real jobs/actions services, over in-memory store fakes. Every
// response is validated against its spec schema with undocumented fields
// treated as errors. The spec walk is data-driven: an operation or status
// added to the spec has no scenario until one is written, and fails here.
import { describe, expect, it, vi } from 'vitest'
import { IntegrationClient } from '../../examples/integration-client/client.ts'

vi.mock('nuxt/server', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).nuxtServer(),
)
vi.mock('../../apps/farm/server/utils/integration-auth-runtime.ts', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).authRuntime(),
)
vi.mock('../../apps/farm/server/utils/integration-jobs-runtime.ts', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).jobsRuntime(),
)
vi.mock('../../apps/farm/server/services/spool-usage.ts', async (original) =>
  (await import('../helpers/api-v1-contract/mocks.ts')).spoolUsage(
    original as never,
  ),
)
vi.mock(
  '../../apps/farm/server/services/signalling-runtime-bootstrap.ts',
  async () =>
    (await import('../helpers/api-v1-contract/mocks.ts')).signalling(),
)
vi.mock(
  '../../apps/farm/server/storage/webhook-postgres.ts',
  async (original) =>
    (await import('../helpers/api-v1-contract/mocks.ts')).webhookStorage(
      original as never,
    ),
)

import { mismatches } from '../helpers/api-v1-contract/mismatches.ts'
import {
  apiBase,
  type CallInput,
  call,
  matchRoute,
  routeFiles,
} from '../helpers/api-v1-contract/router.ts'
import {
  allScenarios,
  tokenFor,
  type Outcome,
  type Scenario,
} from '../helpers/api-v1-contract/scenarios.ts'
import { validateValue } from '../helpers/api-v1-contract/schema.ts'
import {
  operations,
  resolveRef,
  type OperationSpec,
  type ResponseSpec,
  type Schema,
} from '../helpers/api-v1-contract/spec.ts'
import { freshWorld, ids } from '../helpers/api-v1-contract/world.ts'
import { jobBody } from '../helpers/api-v1-contract/world.ts'
import { openJourney } from '../helpers/api-v1-contract/journey.ts'

const ops = operations()
const scenarios = allScenarios()
scenarios.push(...physicalSpoolScenarios())
const pairs = ops.flatMap((op) =>
  op.responses.map((response) => ({
    op,
    response,
    key: `${op.key} ${response.status}`,
  })),
)

function physicalSpoolScenarios(): Scenario[] {
  const base = '/inventory/spools/physical'
  const farmQuery = `?farmId=${ids.farmA}`
  const routes = [
    {
      method: 'POST',
      path: base,
      scope: 'inventory:write',
      suffix: '',
      success: '201',
    },
    {
      method: 'GET',
      path: `${base}/{spoolId}`,
      scope: 'inventory:read',
      suffix: '/7',
      success: '200',
    },
    {
      method: 'POST',
      path: `${base}/{spoolId}/withdraw`,
      scope: 'inventory:write',
      suffix: '/7/withdraw',
      success: '200',
    },
  ] as const

  return routes.flatMap(({ method, path, scope, suffix, success }) => {
    const scenario = (
      status: string,
      name: string,
      options: {
        input?: Partial<CallInput>
        noToken?: boolean
        wrongScope?: boolean
        printerOnly?: boolean
        failPool?: boolean
        rateLimited?: boolean
      } = {},
    ): Scenario => ({
      op: `${method} ${path}`,
      status,
      name,
      async run(world) {
        const app = world.addApp(
          [
            {
              scopes: [options.wrongScope ? 'jobs:read' : scope],
              ...(options.printerOnly ? { printerId: ids.printerA1 } : {}),
            },
          ],
          { sandbox: true },
        )
        const token = options.noToken ? undefined : await tokenFor(world, app)
        let failPool = false
        const spool = { id: 7, location: 'Gaveta A', revision: '71:(0,1)' }
        Object.assign(world.pool as object, {
          begin: (
            work: (
              tx: (
                query: TemplateStringsArray,
                ...values: unknown[]
              ) => unknown,
            ) => unknown,
          ) => {
            if (failPool) throw new Error('pool down')
            return work((query, ...values) => {
              const text = query.join('')
              if (text.includes('farm.integration_app_grants'))
                return [{ id: 'grant' }]
              if (text.includes('FROM farm.spool_filaments'))
                return values[1] === 1 ? [{ id: 1 }] : []
              if (text.includes('INSERT INTO farm.spools'))
                return [{ ...spool, id: 8, location: values[3] }]
              if (text.includes('UPDATE farm.spools'))
                return [{ ...spool, location: null, revision: '72:(0,2)' }]
              if (text.includes('FROM farm.spools'))
                return values[1] === spool.id ? [spool] : []
              throw new Error('Unexpected physical inventory query')
            })
          },
        })
        let body
        if (suffix === '') body = { filamentId: 1, location: spool.location }
        if (suffix.endsWith('/withdraw')) {
          const appRead = world.addApp([{ scopes: ['inventory:read'] }], {
            sandbox: true,
          })
          const lookup = await call({
            method: 'GET',
            path: `${base}/7${farmQuery}`,
            token: await tokenFor(world, appRead),
          })
          body = {
            expectedLocation: spool.location,
            version: (lookup.json as { version?: string }).version,
          }
        }
        const input: CallInput = {
          method,
          path: base + suffix + farmQuery,
          ...(body ? { body } : {}),
          ...(token ? { token } : {}),
          ...options.input,
        }
        failPool = options.failPool === true
        if (options.rateLimited) {
          world.config.integrationAuth.readLimit = 1
          world.config.integrationAuth.writeLimit = 1
          await call(input)
        }
        return { input, result: await call(input) }
      },
    })

    const cases = [
      scenario(success, 'farm-wide sandbox grant'),
      scenario('400', 'missing required farmId', {
        input: { path: base + suffix },
      }),
      scenario('401', 'missing bearer token', { noToken: true }),
      scenario('403', 'token lacks the operation scope', { wrongScope: true }),
      scenario('404', 'outside the farm grant', {
        input: { path: base + suffix + `?farmId=${ids.farmB}` },
      }),
      scenario('404', 'printer-only grant cannot access farm inventory', {
        printerOnly: true,
      }),
      scenario('405', 'unsupported method', { input: { method: 'DELETE' } }),
      scenario('429', 'exhausted request budget', { rateLimited: true }),
      scenario('503', 'spool storage unavailable', { failPool: true }),
    ]
    if (method === 'POST') {
      cases.push(
        scenario('413', 'JSON body exceeds 8 KiB', {
          input: {
            body: ' '.repeat(8193),
            headers: { 'content-type': 'application/json' },
          },
        }),
        scenario('415', 'JSON content type required', {
          input: { headers: { 'content-type': 'text/plain' } },
        }),
      )
    }
    if (suffix.endsWith('/withdraw')) {
      cases.push(
        scenario('409', 'stale version', {
          input: {
            body: { expectedLocation: 'Gaveta A', version: 'x'.repeat(43) },
          },
        }),
      )
    }
    return cases
  })
}

const statusMatches = (documented: string, actual: number) =>
  /^\dXX$/.test(documented)
    ? Math.floor(actual / 100) === Number(documented[0])
    : Number(documented) === actual

function responseSpecFor(op: OperationSpec, actual: number) {
  return op.responses.find((response) => statusMatches(response.status, actual))
}

const mediaType = (value: string | null) =>
  value?.split(';')[0]?.trim().toLowerCase()

/**
 * Documented headers no handler sends yet. The 503 response documents
 * Retry-After but every 503 is produced without one; a test below asserts the
 * header is still absent so the exception cannot outlive a fix.
 */
const unsentHeaders = new Set(['503 Retry-After'])

function headerViolations(response: ResponseSpec, headers: Headers) {
  const out: string[] = []
  for (const { name, schema } of response.headers) {
    const value = headers.get(name)
    if (value === null && unsentHeaders.has(`${response.status} ${name}`))
      continue
    if (value === null) {
      out.push(`${name}: documented header is missing`)
      continue
    }
    const typed =
      schema.type === 'integer' && /^\d+$/.test(value) ? Number(value) : value
    out.push(...validateValue(schema, typed, `header ${name}`))
  }
  return out
}

function requestViolations(op: OperationSpec, outcome: Outcome) {
  const body = op.requestBody
  const { input } = outcome
  if (!body || input.body === undefined) return []
  const [type, schema] = Object.entries(body.content)[0] as [string, Schema]
  if (type === 'application/x-www-form-urlencoded')
    return validateValue(
      schema,
      Object.fromEntries(new URLSearchParams(String(input.body))),
      'request',
    )
  const value =
    typeof input.body === 'string' ? JSON.parse(input.body) : input.body
  return validateValue(schema, value, 'request')
}

/** The Action schema leaves `args` free-form; it must still be an ActionRequest's args. */
function actionArgsViolations(json: unknown) {
  const action = json as { action: string; args: Record<string, unknown> }
  return validateValue(
    resolveRef('#/components/schemas/ActionRequest'),
    { action: action.action, args: action.args },
    'Action',
  )
}

function violationsOf(op: OperationSpec, scenario: Scenario, outcome: Outcome) {
  const { result } = outcome
  const out: string[] = []
  const response = responseSpecFor(op, result.status)
  if (!response)
    return [`HTTP ${result.status} is not a documented response of ${op.key}`]
  if (!statusMatches(scenario.status, result.status))
    out.push(
      `expected ${scenario.status}, got ${result.status}: ${result.text.slice(0, 300)}`,
    )
  if (/^\dXX$/.test(response.status)) return out
  const types = Object.keys(response.content)
  if (types.length === 0) {
    if (result.text !== '')
      out.push(`documented without a body, got ${result.text.slice(0, 100)}`)
  } else {
    const actual = mediaType(result.headers.get('content-type'))
    if (!actual || !types.includes(actual))
      out.push(`content-type ${actual} not in ${types.join(', ')}`)
    else if (result.json === undefined) out.push('body is not JSON')
    else {
      const schema = response.content[actual] as Schema
      out.push(...validateValue(schema, result.json))
      if (
        op.key.endsWith('/actions') || op.key === 'GET /actions/{actionId}'
          ? Number(response.status) < 300
          : false
      )
        out.push(...actionArgsViolations(result.json))
    }
  }
  out.push(...headerViolations(response, result.headers))
  const location = result.headers.get('location')
  if (
    /^20[12]$/.test(response.status) &&
    response.headers.some((h) => h.name === 'Location')
  )
    if (!location?.startsWith(`${apiBase}/`))
      out.push(`Location ${location} is not under ${apiBase}/`)
  if (Number(response.status) < 300) out.push(...requestViolations(op, outcome))
  return out
}

describe('every route file and spec operation line up', () => {
  it('has a v1 route file for each documented operation', () => {
    const missing = ops
      .filter((op) => {
        const concrete = op.path.replace(
          /\{[^}]+\}/g,
          '00000000-0000-4000-8000-000000000000',
        )
        const route = matchRoute(op.method, concrete)
        return !route || route.route.catchAll
      })
      .map((op) => op.key)
    expect(missing).toEqual([])
  })

  it('documents each route file that is not the 404 catch-all', () => {
    const documented = new Set(
      ops.map((op) => {
        const segments = op.path.split('/').filter(Boolean)
        return `${op.method} ${segments.map((s) => (s.startsWith('{') ? '*' : s)).join('/')}`
      }),
    )
    const undocumented = routeFiles()
      .filter((route) => !route.catchAll)
      .map(
        (route) =>
          `${route.method} ${route.segments.map((s) => (/^\[.+\]$/.test(s) ? '*' : s)).join('/')}`,
      )
      .filter((entry) => !documented.has(entry))
    expect(undocumented).toEqual([])
  })

  it('answers unknown v1 paths with the catch-all 404', async () => {
    const route = matchRoute('GET', '/nope/at/all')
    expect(route?.route.catchAll).toBe(true)
  })
})

describe('coverage of the spec', () => {
  it.each(pairs.map((pair) => [pair.key, pair] as const))(
    '%s has a scenario or a recorded mismatch',
    (key, pair) => {
      const covered = scenarios.some(
        (scenario) =>
          scenario.op === pair.op.key &&
          scenario.status === pair.response.status,
      )
      const mismatch = key in mismatches
      expect(
        covered || mismatch,
        `${key}: add a scenario in tests/helpers/api-v1-contract/scenarios.ts`,
      ).toBe(true)
      expect(
        covered && mismatch,
        `${key} is both covered and listed as a mismatch`,
      ).toBe(false)
    },
  )

  it('has no scenario for an operation or status the spec lacks', () => {
    const known = new Set(pairs.map((pair) => pair.key))
    const stale = scenarios
      .map((scenario) => `${scenario.op} ${scenario.status}`)
      .filter((key) => !known.has(key))
    expect([...new Set(stale)]).toEqual([])
    const staleMismatch = Object.keys(mismatches).filter(
      (key) => !known.has(key),
    )
    expect(staleMismatch).toEqual([])
  })
})

describe('responses match the spec', () => {
  for (const op of ops) {
    describe(op.key, () => {
      for (const scenario of scenarios.filter((entry) => entry.op === op.key)) {
        it(`${scenario.status}: ${scenario.name}`, async () => {
          const world = freshWorld()
          const outcome = await scenario.run(world)
          expect(violationsOf(op, scenario, outcome)).toEqual([])
          for (const app of world.apps.values())
            expect(outcome.result.text).not.toContain(app.secret)
        })
      }
    })
  }
})

it('routes reference-client start, pause and cancel requests through v1', async () => {
  const world = freshWorld()
  const scopes = ['jobs:start', 'control:basic'] as const
  const app = world.addApp([{ printerId: ids.printerA1, scopes: [...scopes] }])
  const operationsSeen: string[] = []
  const client = new IntegrationClient(
    'http://127.0.0.1',
    app.clientId,
    app.secret,
    async (url, init) => {
      const request = new Request(url, init)
      const path = new URL(request.url).pathname.slice(apiBase.length)
      const input = {
        method: request.method,
        path,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      }
      const result = await call(input)
      const key = `POST ${path.replace(ids.printerA1, '{printerId}')}`
      const op = ops.find((entry) => entry.key === key)!
      const status = path === '/oauth/token' ? '200' : '202'
      const scenario = scenarios.find(
        (entry) => entry.op === key && entry.status === status,
      )!
      expect(violationsOf(op, scenario, { input, result })).toEqual([])
      operationsSeen.push(key)
      return new Response(result.text, result)
    },
  )

  await client.authenticate([...scopes])
  await client.submitJob(ids.printerA1, jobBody, 'reference-start')
  await client.submitAction(ids.printerA1, 'pause', {}, 'reference-pause')
  await client.submitAction(ids.printerA1, 'cancel', {}, 'reference-cancel')

  expect(operationsSeen).toEqual([
    'POST /oauth/token',
    'POST /printers/{printerId}/jobs',
    'POST /printers/{printerId}/actions',
    'POST /printers/{printerId}/actions',
  ])
  expect([...world.envelopes.commands.values()]).toEqual([
    {
      kind: 'job',
      job: {
        file_url: jobBody.fileUrl,
        sha256: jobBody.sha256,
        size_bytes: jobBody.sizeBytes,
        display_name: jobBody.displayName,
      },
    },
    { kind: 'action', action: { action: 'pause', args: {} } },
    { kind: 'action', action: { action: 'cancel', args: {} } },
  ])
})

it('executes a sandbox print journey through the reference client over loopback', async ({
  onTestFinished,
}) => {
  const world = freshWorld()
  world.authStore.printers = world.authStore.printers.map((printer) =>
    printer.id === ids.printerA1 ? { ...printer, sandbox: true } : printer,
  )
  const scopes = ['jobs:start', 'control:basic'] as const
  const app = world.addApp(
    [{ printerId: ids.printerA1, scopes: [...scopes] }],
    { sandbox: true },
  )
  const cleanups: (() => void | Promise<void>)[] = []
  onTestFinished(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
  })
  const journey = await openJourney(world, (cleanup) => cleanups.push(cleanup))
  vi.spyOn(world.envelopes, 'deliver').mockImplementation(journey.deliver)
  const exchanges: Outcome[] = []
  const client = new IntegrationClient(
    journey.apiOrigin,
    app.clientId,
    app.secret,
    async (url, init) => {
      const request = new Request(url, init)
      const input = {
        method: request.method,
        path: new URL(request.url).pathname.slice(apiBase.length),
        headers: Object.fromEntries(request.headers),
        body: await request.clone().text(),
      }
      const response = await fetch(request)
      const text = await response.clone().text()
      exchanges.push({
        input,
        result: {
          status: response.status,
          headers: response.headers,
          text,
          json: JSON.parse(text),
          unrouted: false,
        },
      })
      return response
    },
  )

  await client.authenticate([...scopes])
  await client.submitJob(ids.printerA1, journey.job, 'reference-start')
  expect(journey.printer.printState).toBe('printing')
  await client.submitAction(ids.printerA1, 'pause', {}, 'reference-pause')
  expect(journey.printer.printState).toBe('paused')
  await client.submitAction(ids.printerA1, 'cancel', {}, 'reference-cancel')
  expect(journey.printer.printState).toBe('idle')

  expect(journey.uploaded).toHaveLength(1)
  expect(journey.executed).toEqual(['start_print', 'pause', 'cancel'])
  expect(
    journey.reports
      .map(({ outcome }) => outcome)
      .filter((outcome) => outcome !== 'delivered'),
  ).toEqual(['started', 'completed', 'completed'])
  expect(exchanges.map(({ input }) => input.path)).toEqual([
    '/oauth/token',
    `/printers/${ids.printerA1}/jobs`,
    `/printers/${ids.printerA1}/actions`,
    `/printers/${ids.printerA1}/actions`,
  ])
  for (const exchange of exchanges) {
    const { input } = exchange
    const key = `POST ${input.path.replace(ids.printerA1, '{printerId}')}`
    const op = ops.find((entry) => entry.key === key)!
    const status = input.path === '/oauth/token' ? '200' : '202'
    const scenario = scenarios.find(
      (entry) => entry.op === key && entry.status === status,
    )!
    expect(violationsOf(op, scenario, exchange)).toEqual([])
  }
}, 15_000)

describe('documented headers no handler sends yet', () => {
  it('503 answers still carry no Retry-After', async () => {
    const withHeader: string[] = []
    for (const scenario of scenarios.filter(
      (entry) => entry.status === '503',
    )) {
      const { result } = await scenario.run(freshWorld())
      if (
        responseSpecFor(
          ops.find((op) => op.key === scenario.op)!,
          503,
        )?.headers.some((header) => header.name === 'Retry-After') &&
        result.headers.has('retry-after')
      )
        withHeader.push(`${scenario.op}: ${scenario.name}`)
    }
    expect(
      withHeader,
      'Retry-After is now sent on 503: remove it from unsentHeaders',
    ).toEqual([])
  })

  it('rejects blank and hexadecimal integer response headers', () => {
    const response = {
      status: '429',
      description: 'test',
      content: {},
      headers: [
        { name: 'Retry-After', schema: { type: 'integer', minimum: 0 } },
      ],
    } as ResponseSpec
    expect(
      headerViolations(response, new Headers({ 'Retry-After': '' })),
    ).not.toEqual([])
    expect(
      headerViolations(response, new Headers({ 'Retry-After': '0x10' })),
    ).not.toEqual([])
  })
})

describe('documented responses no handler produces yet', () => {
  const entries = Object.entries(mismatches)
  if (entries.length === 0) {
    it('has no documented mismatches', () => {
      expect(mismatches).toEqual({})
    })
  }
  it.each(entries)('%s', async (key, mismatch) => {
    const documented = key.slice(key.lastIndexOf(' ') + 1)
    const result = await mismatch.probe(freshWorld())
    expect(
      result.status,
      `${key} is now produced (${mismatch.reason}): remove it from mismatches.ts and add a scenario`,
    ).not.toBe(Number(documented))
  })
})

describe('a handler response with an undocumented field fails the contract', () => {
  it('flags a field the Connector query result carries beyond the spec', async () => {
    const world = freshWorld()
    const files = scenarios.find(
      (entry) =>
        entry.op === 'GET /printers/{printerId}/files' &&
        entry.status === '200',
    )!
    world.inbox = {
      kind: 'files',
      data: [
        {
          name: 'a.gcode',
          sizeBytes: 1,
          modifiedAt: 1,
          internalPath: '/srv/a',
        },
      ],
      nextOffset: null,
    } as never
    const app = world.addApp([{ scopes: ['files:read'] }])
    const input = {
      method: 'GET',
      path: `/printers/${ids.printerA1}/files`,
      token: await tokenFor(world, app),
    }
    const outcome = { input, result: await call(input) }
    expect(outcome.result.status).toBe(200)
    expect(
      violationsOf(
        ops.find((op) => op.key === files.op)!,
        files,
        outcome,
      ),
    ).toEqual(['$.data[0].internalPath: undocumented field'])
  })
})

describe('the validator rejects undocumented fields', () => {
  const page = resolveRef('#/components/schemas/PrinterPage')
  const printer = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    printerKey: 'p',
    controls: [],
    sandbox: false,
  }
  it('accepts a documented page', () => {
    expect(validateValue(page, { data: [printer], nextCursor: null })).toEqual(
      [],
    )
  })
  it('rejects an extra field on a nested object', () => {
    expect(
      validateValue(page, {
        data: [{ ...printer, serialNumber: 'x' }],
        nextCursor: null,
      }),
    ).toEqual(['$.data[0].serialNumber: undocumented field'])
  })
  it('rejects an extra field beside allOf members', () => {
    expect(
      validateValue(page, { data: [], nextCursor: null, total: 3 }),
    ).toEqual(['$.total: undocumented field'])
  })
  it('rejects an extra field inside the free-form-looking Action arguments', () => {
    const request = resolveRef('#/components/schemas/ActionRequest')
    expect(
      validateValue(request, { action: 'pause', args: { force: true } }),
    ).not.toEqual([])
  })
  it('rejects a wrong type, a missing field and an unlisted enum value', () => {
    const status = resolveRef('#/components/schemas/PrinterStatus')
    const out = validateValue(status, { printerId: 5, state: 'melted' })
    expect(out.join('\n')).toMatch(/printerId/)
    expect(out.join('\n')).toMatch(/farmId: required/)
    expect(out.join('\n')).toMatch(/state/)
  })
})

describe('resin artifacts on the existing library and job routes', () => {
  it('publishes the catalog, rejects mismatches, and replays the immutable version', async () => {
    const world = freshWorld()
    const token = await tokenFor(
      world,
      world.addApp([
        {
          scopes: [
            'library:read',
            'library:write',
            'jobs:start',
            'jobs:write',
            'jobs:read',
          ],
        },
      ]),
    )
    const library = await call({
      method: 'GET',
      path: `/library?farmId=${ids.farmA}`,
      token,
    })
    expect(library.status).toBe(200)
    expect(library.json).toMatchObject({
      resinArtifactFormats: expect.arrayContaining([
        expect.objectContaining({
          extension: '.pm7m',
          profiles: ['anycubic:photon-mono-m7-max'],
        }),
      ]),
    })
    const body = {
      farmId: ids.farmA,
      name: 'fixture.pm7m',
      contentBase64: Buffer.from('spec-derived, not captured').toString(
        'base64',
      ),
      resinProfile: 'anycubic:photon-mono-m7-max',
    }
    const incompatible = await call({
      method: 'POST',
      path: '/library',
      token,
      body: { ...body, resinProfile: 'anycubic:photon-mono-m7-pro' },
    })
    expect(incompatible.status).toBe(422)
    expect(incompatible.json).toMatchObject({
      errors: [{ pointer: '/resinProfile', detail: 'profile-mismatch' }],
    })
    const accepted = await call({
      method: 'POST',
      path: '/library',
      token,
      body,
    })
    expect(accepted.status).toBe(201)
    const version = (
      accepted.json as { version: { id: string; sha256: string } }
    ).version
    expect(version).toMatchObject({
      kind: 'resin',
      resinProfile: body.resinProfile,
      plateCount: 1,
    })
    const submit = {
      method: 'POST',
      path: `/printers/${ids.printerA1}/jobs`,
      token,
      headers: { 'idempotency-key': 'resin-replay' },
    }
    const wrongPlate = await call({
      ...submit,
      body: { libraryVersionId: version.id, plate: 2 },
    })
    expect(wrongPlate.status).toBe(422)
    expect(wrongPlate.json).toMatchObject({
      errors: [{ pointer: '/plate', detail: 'plate-mismatch' }],
    })
    const replay = await call({
      ...submit,
      body: { libraryVersionId: version.id },
    })
    expect(replay.status).toBe(202)
    expect(replay.json).toMatchObject({
      libraryVersionId: version.id,
      sha256: version.sha256,
      resinProfile: body.resinProfile,
      plate: 1,
    })
    const { id: jobId } = replay.json as { id: string }
    const envelope = world.envelopes.byResource(jobId)!
    expect(world.envelopes.commands.get(envelope.cmdId)).toMatchObject({
      kind: 'action',
      action: {
        action: 'start_library_print',
        args: {
          versionId: version.id,
          sha256: version.sha256,
          profile: body.resinProfile,
          plate: 1,
        },
      },
    })
    envelope.status = 'refused'
    envelope.refusalCode = 'unsupported'
    envelope.resultDetail = 'resin-artifact-dispatch-unavailable'
    const receipt = await call({ method: 'GET', path: `/jobs/${jobId}`, token })
    expect(receipt.status).toBe(200)
    expect(receipt.json).toMatchObject({
      libraryVersionId: version.id,
      sha256: version.sha256,
      status: 'refused',
      refusal: {
        code: 'unsupported',
        detail: 'resin-artifact-dispatch-unavailable',
      },
    })
  })
})

describe('sandbox printer operational availability', () => {
  it('applies a qualified target, refuses the others, and restores only the current app-owned version', async () => {
    const world = freshWorld()
    const app = world.addApp(
      [{ scopes: ['control:extended', 'printers:read'] }],
      { sandbox: true },
    )
    const other = world.addApp([{ scopes: ['control:extended'] }], {
      sandbox: true,
    })
    const token = await tokenFor(world, app)
    const otherToken = await tokenFor(world, other)
    const [qualified, unavailable] = world.authStore.printers
    const now = Date.now()
    qualified!.sandbox = true
    qualified!.observedAt = now
    // Spec-derived, not captured. This projects a qualified Moonraker driver
    // observation. No test opens a printer connection or sends a command.
    const observed = {
      printerKey: qualified!.printerKey,
      state: 'printing',
      progress: 0.5,
      observedAt: now,
      identity: {
        vendor: 'Klipper',
        model: 'Moonraker Generic',
        firmware: 'Moonraker 2.0.0',
      },
      controls: ['pause', 'resume', 'cancel', 'start_print'],
    }
    qualified!.state = observed
    unavailable!.sandbox = true
    unavailable!.state = null
    const unsupported = 'aaaaaaaa-0000-4000-8000-000000000003'
    world.authStore.printers.push({
      ...qualified!,
      id: unsupported,
      printerKey: 'unsupported-printer',
      state: {
        ...observed,
        printerKey: 'unsupported-printer',
        controls: ['pause'],
      },
    })

    const path = '/printers/mode'
    const readPath = `/printers/${ids.printerA1}/mode`
    const set = await call({
      method: 'POST',
      path,
      token,
      body: {
        action: 'set',
        mode: 'maintenance',
        targets: [
          { printerId: ids.printerA1, expectedVersion: null },
          { printerId: ids.printerA2, expectedVersion: null },
          { printerId: unsupported, expectedVersion: null },
          { printerId: ids.printerB1, expectedVersion: null },
        ],
      },
    })
    const {
      data: [applied],
    } = set.json as { data: { version: string }[] }
    expect(set.status).toBe(200)
    expect(set.json).toEqual({
      data: [
        {
          printerId: ids.printerA1,
          outcome: 'applied',
          mode: 'maintenance',
          label: 'Em manutenção',
          version: expect.any(String),
        },
        {
          printerId: ids.printerA2,
          outcome: 'denied',
          reason: 'observation-unavailable',
        },
        {
          printerId: unsupported,
          outcome: 'unsupported',
          reason: 'capability-unqualified',
        },
        { printerId: ids.printerB1, outcome: 'denied', reason: 'not-found' },
      ],
    })
    expect(
      validateValue(
        resolveRef('#/components/schemas/FleetModeResults'),
        set.json,
      ),
    ).toEqual([])
    expect(qualified!.state).toBe(observed)
    expect(
      (await call({ method: 'GET', path: readPath, token })).json,
    ).toMatchObject({ mode: 'maintenance', version: applied!.version })

    const restore = (appToken: string) =>
      call({
        method: 'POST',
        path,
        token: appToken,
        body: {
          action: 'restore',
          targets: [
            { printerId: ids.printerA1, expectedVersion: applied!.version },
          ],
        },
      })
    expect((await restore(otherToken)).json).toMatchObject({
      data: [{ outcome: 'denied', reason: 'not-reversible' }],
    })
    expect((await restore(token)).json).toMatchObject({
      data: [{ outcome: 'applied', mode: 'in-service' }],
    })
    expect((await restore(token)).json).toMatchObject({
      data: [{ outcome: 'denied', reason: 'version-conflict' }],
    })
    expect(world.inboxCalls).toHaveLength(0)
  })
})
