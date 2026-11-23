// Contract test: every path and status code in docs/api/openapi-v1.yaml is
// exercised against the real v1 route files, the real authorizing middleware
// and the real jobs/actions services, over in-memory store fakes. Every
// response is validated against its spec schema with undocumented fields
// treated as errors. The spec walk is data-driven: an operation or status
// added to the spec has no scenario until one is written, and fails here.
import { describe, expect, it, vi } from 'vitest'
import { IntegrationClient } from '../../examples/integration-client/client.ts'

vi.mock('nuxt/server', async () => {
  const server = (
    await import('../helpers/api-v1-contract/mocks.ts')
  ).nuxtServer()
  return {
    ...server,
    useRuntimeConfig: () => ({
      ...server.useRuntimeConfig(),
      auth: { credentialEncryptionKey: 'contract-key'.repeat(4) },
    }),
  }
})
vi.mock('../../apps/farm/server/storage/alert-rules-postgres.ts', () => ({
  alertRulesStore: () => alertSettingsFixture(currentWorld()),
}))
vi.mock('node:https', async (original) => {
  const { EventEmitter } = await import('node:events')
  return {
    ...(await original<typeof import('node:https')>()),
    // Spec-derived sandbox receiver. It rejects the notification without opening a socket.
    request: (
      options: { hostname: string; path: string },
      respond: (response: { statusCode: number; destroy: () => void }) => void,
    ) => {
      expect(options).toMatchObject({ hostname: '1.1.1.1', path: '/fixture' })
      return Object.assign(new EventEmitter(), {
        end: () => respond({ statusCode: 503, destroy: () => {} }),
      })
    },
  }
})
vi.mock('../../apps/farm/server/utils/integration-auth-runtime.ts', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).authRuntime(),
)
vi.mock('../../apps/farm/server/utils/integration-jobs-runtime.ts', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).jobsRuntime(),
)
vi.mock('nuxt/server', async () => {
  const server = (
    await import('../helpers/api-v1-contract/mocks.ts')
  ).nuxtServer()
  return {
    ...server,
    useRuntimeConfig: () => ({
      ...server.useRuntimeConfig(),
      auth: { credentialEncryptionKey: 'contract-key'.repeat(4) },
    }),
  }
})
vi.mock('../../apps/farm/server/storage/alert-rules-postgres.ts', () => ({
  alertRulesStore: () => alertSettingsFixture(currentWorld()),
}))
vi.mock('node:https', async (original) => {
  const { EventEmitter } = await import('node:events')
  return {
    ...(await original<typeof import('node:https')>()),
    // Spec-derived sandbox receiver. It rejects the notification without opening a socket.
    request: (
      options: { hostname: string; path: string },
      respond: (response: { statusCode: number; destroy: () => void }) => void,
    ) => {
      expect(options).toMatchObject({ hostname: '1.1.1.1', path: '/fixture' })
      return Object.assign(new EventEmitter(), {
        end: () => respond({ statusCode: 503, destroy: () => {} }),
      })
    },
  }
})
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
import {
  currentWorld,
  freshWorld,
  ids,
} from '../helpers/api-v1-contract/world.ts'
import { jobBody } from '../helpers/api-v1-contract/world.ts'
import { openJourney } from '../helpers/api-v1-contract/journey.ts'
import type { App, World } from '../helpers/api-v1-contract/world.ts'
import type { IntegrationScope } from '../../apps/farm/server/services/integration-apps.ts'
import type {
  EnvironmentControlEnvelope,
  EnvironmentControlPorts,
  EnvironmentControlRecord,
} from '../../apps/farm/server/utils/integration-environment-controls.ts'
import { setIntegrationEnvironmentControlPorts } from '../../apps/farm/server/utils/integration-environment-controls-runtime.ts'

type ContractWorld = ReturnType<typeof freshWorld>

const settingsByWorld = new WeakMap<
  ContractWorld,
  ReturnType<typeof makeAlertSettings>
>()

function makeAlertSettings() {
  const rules = new Map<string, boolean>()
  const channels = new Map<string, string>()
  return {
    canManage: true,
    list(farmId: string) {
      return rules.has(farmId)
        ? [{ kind: 'paused', enabled: rules.get(farmId) }]
        : []
    },
    async manage(
      appId: string,
      farmId: string,
      _grantIds: string[],
      work: (settings: {
        writeRule: (kind: string, enabled: boolean) => void
        writeChannel: (sealed: string) => void
        readChannel: () => string | undefined
      }) => Promise<unknown>,
    ) {
      if (!this.canManage) return null
      return {
        value: await work({
          writeRule(kind, enabled) {
            expect(kind).toBe('paused')
            rules.set(farmId, enabled)
          },
          writeChannel(sealed) {
            expect(sealed).toMatch(/^O3W1\./)
            expect(sealed).not.toContain(channelBody.secret)
            expect(sealed).not.toContain(channelBody.url)
            channels.set(farmId + appId, sealed)
          },
          readChannel() {
            return channels.get(farmId + appId)
          },
        }),
      }
    },
  }
}

function alertSettingsFixture(world: ContractWorld) {
  let fixture = settingsByWorld.get(world)
  if (!fixture) {
    fixture = makeAlertSettings()
    settingsByWorld.set(world, fixture)
  }
  return fixture
}

const channelBody = {
  url: 'https://127.0.0.1/fixture',
  secret: 'channel-secret'.repeat(3),
}
const channelPath = '/notification-channels/{farmId}'
const alertSettingsOperations = [
  ['GET', '/alert-rules/{farmId}', 'printers:read'],
  ['PATCH', '/alert-rules/{farmId}/{kind}', 'alerts:manage'],
  ['PUT', channelPath, 'alerts:manage'],
  ['POST', channelPath + '/test', 'alerts:manage'],
] as const

function alertSettingsScenarios(): Scenario[] {
  return alertSettingsOperations.flatMap(([method, path, scope]) => {
    const scenario = (
      status: string,
      name: string,
      run: (world: ContractWorld, input: CallInput) => Promise<Outcome>,
    ): Scenario => ({
      op: method + ' ' + path,
      status,
      name,
      run: (world) =>
        run(world, {
          method,
          path: path.replace('{farmId}', ids.farmA).replace('{kind}', 'paused'),
          ...(method === 'PATCH'
            ? { body: { enabled: false } }
            : method === 'PUT'
              ? { body: channelBody }
              : {}),
        }),
    })
    const send = async (input: CallInput) => ({
      input,
      result: await call(input),
    })
    const authorized = async (world: ContractWorld, input: CallInput) => {
      const app = world.addApp([{ scopes: [scope] }], { sandbox: true })
      return { ...input, token: await tokenFor(world, app) }
    }
    return [
      scenario(
        '200',
        'reads, updates, configures or reports the test outcome',
        async (world, input) => {
          input = await authorized(world, input)
          if (method === 'POST') {
            const configured = await call({
              ...input,
              method: 'PUT',
              path: input.path.replace(/\/test$/, ''),
              body: channelBody,
            })
            expect(configured.status).toBe(200)
          }
          const outcome = await send(input)
          if (method === 'POST')
            expect(outcome.result.json).toEqual({
              attempted: false,
              status: 'not-run',
            })
          if (method === 'PUT') {
            expect(outcome.result.text).not.toContain(channelBody.secret)
            expect(outcome.result.text).not.toContain(channelBody.url)
          }
          return outcome
        },
      ),
      scenario('400', 'unexpected query parameter', async (world, input) =>
        send(
          await authorized(world, { ...input, path: input.path + '?extra=1' }),
        ),
      ),
      scenario('401', 'token missing', (_world, input) => send(input)),
      scenario('403', 'scope missing', async (world, input) => {
        const app = world.addApp([{ scopes: ['jobs:start'] }])
        return send({ ...input, token: await tokenFor(world, app) })
      }),
      scenario('404', 'another farm', async (world, input) =>
        send(
          await authorized(world, {
            ...input,
            path: input.path.replace(ids.farmA, ids.farmB),
          }),
        ),
      ),
      scenario('404', 'printer-only grant', async (world, input) => {
        const app = world.addApp([
          { scopes: [scope], printerId: ids.printerA1 },
        ])
        return send({ ...input, token: await tokenFor(world, app) })
      }),
      scenario('405', 'wrong method', async (world, input) => {
        const allowed = await authorized(world, input)
        return send({
          method: 'DELETE',
          path: input.path,
          token: allowed.token,
        })
      }),
      scenario('429', 'request limit reached', async (world, input) => {
        world.config.integrationAuth.readLimit = 1
        world.config.integrationAuth.writeLimit = 1
        const allowed = await authorized(world, input)
        await send(allowed)
        return send(allowed)
      }),
      scenario(
        '503',
        'authorization store unavailable',
        async (world, input) => {
          const allowed = await authorized(world, input)
          world.faults.add('auth-store')
          return send(allowed)
        },
      ),
      ...(method === 'GET'
        ? []
        : [
            scenario(
              '403',
              'farm owner role no longer active',
              async (world, input) => {
                alertSettingsFixture(world).canManage = false
                return send(await authorized(world, input))
              },
            ),
            scenario('403', 'grant requires approval', async (world, input) => {
              const app = world.addApp([
                { scopes: [scope], requiresApproval: true },
              ])
              return send({ ...input, token: await tokenFor(world, app) })
            }),
          ]),
      ...(method === 'POST'
        ? [
            scenario(
              '200',
              'sandbox receiver rejected the test delivery',
              async (world, input) => {
                const allowed = await authorized(world, input)
                const configured = await call({
                  ...allowed,
                  method: 'PUT',
                  path: allowed.path.replace(/\/test$/, ''),
                  body: { ...channelBody, url: 'https://1.1.1.1/fixture' },
                })
                expect(configured.status).toBe(200)
                const outcome = await send(allowed)
                expect(outcome.result.json).toEqual({
                  attempted: true,
                  status: 'failed',
                })
                return outcome
              },
            ),
            scenario(
              '404',
              'another app configured the channel',
              async (world, input) => {
                const first = await authorized(world, input)
                expect(
                  (
                    await call({
                      ...first,
                      method: 'PUT',
                      path: first.path.replace(/\/test$/, ''),
                      body: channelBody,
                    })
                  ).status,
                ).toBe(200)
                return send(await authorized(world, input))
              },
            ),
          ]
        : []),
    ]
  })
}

const ops = operations()
const scenarios = [
  ...allScenarios(),
  ...alertSettingsScenarios(),
  ...environmentControlScenarios(),
]
scenarios.push(...physicalSpoolScenarios(), ...spoolIdentityScenarios())
const pairs = ops.flatMap((op) =>
  op.responses.map((response) => ({
    op,
    response,
    key: `${op.key} ${response.status}`,
  })),
)

function spoolIdentityScenarios(): Scenario[] {
  const serviceId = '12345678-1234-4234-8234-123456789abc'
  const binding = { serviceId, serviceSpoolId: 7 }
  return [
    { path: '/inventory', expected: { serviceId } },
    {
      path: '/inventory/spools',
      expected: { serviceId, spoolKey: serviceId + ':7' },
    },
    {
      path: '/inventory/spools/search',
      expected: { ...binding, spoolKey: serviceId + ':7' },
    },
    {
      path: '/inventory/spools/usage',
      expected: { ...binding, spoolKey: serviceId + ':7' },
    },
  ].map(({ path, expected }) => ({
    op: `GET ${path}`,
    status: '200',
    name: 'publishes available Spoolman provenance',
    async run(world) {
      const app = world.addApp([{ scopes: ['inventory:read'] }])
      const inventory = world.inventory[0]!
      inventory.snapshot = { ...(inventory.snapshot as object), serviceId }
      world.spoolStock[0] = Object.assign(world.spoolStock[0]!, binding)
      world.spoolUsage[0] = Object.assign(world.spoolUsage[0]!, binding)
      const input = {
        method: 'GET',
        path: path + (path.endsWith('/usage') ? '?jobId=101' : ''),
        token: await tokenFor(world, app),
      }
      const result = await call(input)
      const { data } = result.json as { data: object[] }
      expect(data[0]).toMatchObject(expected)
      if (data.length > 1) expect(data[1]).not.toHaveProperty('serviceId')
      return { input, result }
    },
  }))
}

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
        requiresApproval?: boolean
        keyConflict?: boolean
        bindingConflict?: boolean
        replay?: boolean
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
              ...(options.requiresApproval ? { requiresApproval: true } : {}),
              ...(options.printerOnly ? { printerId: ids.printerA1 } : {}),
            },
          ],
          { sandbox: true },
        )
        const token = options.noToken ? undefined : await tokenFor(world, app)
        let failPool = false
        let stored: { request_hash: string; response: unknown } | undefined
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
            const tx = (query: TemplateStringsArray, ...values: unknown[]) => {
              const text = query.join('')
              if (text.includes('farm.integration_app_grants'))
                return [{ id: 'grant' }]
              if (text.includes('pg_advisory_xact_lock')) return []
              if (text.includes('SELECT request_hash, response'))
                return stored ? [stored] : []
              if (
                text.includes(
                  'INSERT INTO farm.integration_physical_spool_registrations',
                )
              ) {
                stored = {
                  request_hash: values[2] as string,
                  response: values[3],
                }
                return []
              }
              if (text.includes('FROM farm.spool_filaments'))
                return values[1] === 1 ? [{ id: 1 }] : []
              if (text.includes('INSERT INTO farm.spools')) {
                if (
                  options.input?.body &&
                  typeof options.input.body === 'object' &&
                  'spoolman' in options.input.body
                )
                  expect(values.slice(-2)).toEqual([
                    '12345678-1234-4234-8234-123456789abc',
                    1,
                  ])
                return options.bindingConflict
                  ? []
                  : [{ ...spool, id: 8, location: values[3] }]
              }
              if (text.includes('UPDATE farm.spools'))
                return [{ ...spool, location: null, revision: '72:(0,2)' }]
              if (text.includes('FROM farm.spools'))
                return values[1] === spool.id ? [spool] : []
              throw new Error('Unexpected physical inventory query')
            }
            tx.json = (value: unknown) => value
            return work(tx)
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
          ...(suffix === '' && options.input?.headers === undefined
            ? { headers: { 'idempotency-key': 'physical-key' } }
            : {}),
        }
        failPool = options.failPool === true
        if (options.keyConflict) {
          await call(input)
          input.body = { filamentId: 1, location: 'Gaveta B' }
        }
        if (options.replay) {
          const original = await call(input)
          const replay = await call(input)
          expect(replay.status).toBe(original.status)
          expect(replay.json).toEqual(original.json)
          expect(replay.headers.get('location')).toBe(
            original.headers.get('location'),
          )
        }
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
        scenario('403', 'approval-required grant cannot write', {
          requiresApproval: true,
        }),
        scenario('413', 'JSON body exceeds 8 KiB', {
          input: {
            body: ' '.repeat(8193),
            headers: {
              'content-type': 'application/json',
              ...(suffix === '' ? { 'idempotency-key': 'physical-key' } : {}),
            },
          },
        }),
        scenario('415', 'JSON content type required', {
          input: {
            headers: {
              'content-type': 'text/plain',
              ...(suffix === '' ? { 'idempotency-key': 'physical-key' } : {}),
            },
          },
        }),
      )
    }
    if (suffix === '') {
      const bindingInput = {
        body: {
          filamentId: 1,
          location: 'Gaveta A',
          spoolman: {
            serviceId: '12345678-1234-4234-8234-123456789abc',
            spoolId: 1,
          },
        },
      }
      cases.push(
        scenario('201', 'registers an explicitly bound spool', {
          input: bindingInput,
          replay: true,
        }),
        scenario('409', 'external spool already bound', {
          input: bindingInput,
          bindingConflict: true,
        }),
        scenario('400', 'idempotency key required', { input: { headers: {} } }),
        scenario('409', 'idempotency key reused with different body', {
          keyConflict: true,
        }),
        scenario('201', 'idempotent replay returns original response', {
          replay: true,
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

function headerViolations(response: ResponseSpec, headers: Headers) {
  const out: string[] = []
  for (const { name, schema } of response.headers) {
    const value = headers.get(name)
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
        (op.key.endsWith('/actions') && !op.key.includes('/environment/')) ||
        op.key === 'GET /actions/{actionId}'
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

it('keeps the farm rule available to another authorized reader after a change', async () => {
  const world = freshWorld()
  const writer = world.addApp([{ scopes: ['alerts:manage'] }], {
    sandbox: true,
  })
  const reader = world.addApp([{ scopes: ['printers:read'] }], {
    sandbox: true,
  })
  const path = '/alert-rules/' + ids.farmA
  const token = await tokenFor(world, reader)
  const before = await call({ method: 'GET', path, token })
  expect(before.json).toMatchObject({
    rules: expect.arrayContaining([
      { kind: 'paused', label: 'Pausada', enabled: true },
    ]),
  })
  const changed = await call({
    method: 'PATCH',
    path: path + '/paused',
    token: await tokenFor(world, writer),
    body: { enabled: false },
  })
  expect(changed.status).toBe(200)
  const after = await call({ method: 'GET', path, token })
  expect(after.json).toMatchObject({
    rules: expect.arrayContaining([
      { kind: 'paused', label: 'Pausada', enabled: false },
    ]),
  })
})

it('validates stored unknown telemetry against the response contract', async () => {
  const world = freshWorld()
  const app = world.addApp([{ scopes: ['printers:read'] }])
  const token = await tokenFor(world, app)
  const observedAt = world.clock - 1000
  world.telemetryFixture = {
    states: [
      {
        state: {
          printerKey: 'printer-a',
          state: 'unknown',
          preformStatus: 'unrecognized',
          observedAt,
        },
      },
    ],
    transitions: [
      {
        transition: {
          printerKey: 'printer-a',
          from: 'idle',
          to: 'unknown',
          observedAt,
        },
      },
      {
        transition: {
          printerKey: 'printer-a',
          from: 'unknown',
          to: 'idle',
          observedAt: observedAt + 1,
        },
      },
    ],
  }
  const input = {
    method: 'GET',
    path: `/telemetry/${ids.printerA1}?since=${observedAt}&until=${world.clock}`,
    token,
  }
  const result = await call(input)
  const op = ops.find((entry) => entry.key === 'GET /telemetry/{printerId}')!
  const scenario = scenarios.find(
    (entry) => entry.op === op.key && entry.status === '200',
  )!
  expect(result.status).toBe(200)
  expect(result.json).toMatchObject({
    events: [
      { from: 'idle', to: 'unknown' },
      { from: 'unknown', to: 'idle' },
    ],
    intervals: [{ state: 'unknown' }],
  })
  expect(violationsOf(op, scenario, { input, result })).toEqual([])
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

describe('documented response headers', () => {
  it('sends Retry-After on all documented 503 scenarios', async () => {
    const expected = scenarios
      .filter((entry) => entry.status === '503')
      .map(({ op, name }) => `${op}: ${name}`)
      .sort()
    expect(expected.length).toBeGreaterThan(0)
    const observed: string[] = []
    for (const scenario of scenarios.filter(
      (entry) => entry.status === '503',
    )) {
      const { result } = await scenario.run(freshWorld())
      expect(result.status, `${scenario.op}: ${scenario.name}`).toBe(503)
      expect(
        result.headers.get('retry-after'),
        `${scenario.op}: ${scenario.name}`,
      ).toBe('30')
      observed.push(`${scenario.op}: ${scenario.name}`)
    }
    expect(observed.sort()).toEqual(expected)
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

/* Environment controls (#693): scenarios kept local to this file. */

/** In-memory action and envelope storage; delivery records the Connector outcome given. */
function memoryEnvironmentPorts(
  outcome: Pick<
    EnvironmentControlEnvelope,
    'status' | 'refusalCode' | 'resultDetail'
  > = { status: 'delivered', refusalCode: null, resultDetail: null },
) {
  const records: EnvironmentControlRecord[] = []
  const envelopes = new Map<string, EnvironmentControlEnvelope>()
  const byResource = new Map<string, string>()
  const deliveries: string[] = []
  const envelopeOf = (id: string) => {
    const cmdId = byResource.get(id)
    return cmdId ? (envelopes.get(cmdId) ?? null) : null
  }
  const ports: EnvironmentControlPorts = {
    store: {
      async existing(appId, key) {
        const record = records.find(
          (entry) => entry.appId === appId && entry.idempotencyKey === key,
        )
        return record ? { record, envelope: envelopeOf(record.id) } : null
      },
      async create(record) {
        const prior = records.find(
          (entry) =>
            entry.appId === record.appId &&
            entry.idempotencyKey === record.idempotencyKey,
        )
        if (prior) return { kind: 'existing', record: prior }
        records.push(record)
        return { kind: 'created', record }
      },
      async get(id, appId) {
        const record = records.find(
          (entry) => entry.id === id && entry.appId === appId,
        )
        return record ? { record, envelope: envelopeOf(record.id) } : null
      },
    },
    envelopes: {
      async issue(input) {
        const existing = byResource.get(input.resourceId)
        if (existing)
          return {
            ok: true,
            created: false,
            envelope: envelopes.get(existing)!,
          }
        const envelope: EnvironmentControlEnvelope = {
          cmdId: crypto.randomUUID(),
          status: 'pending',
          refusalCode: null,
          resultDetail: null,
          updatedAt: Date.now(),
        }
        envelopes.set(envelope.cmdId, envelope)
        byResource.set(input.resourceId, envelope.cmdId)
        return { ok: true, created: true, envelope }
      },
      async deliver(cmdId) {
        deliveries.push(cmdId)
        const envelope = envelopes.get(cmdId)!
        Object.assign(envelope, outcome, { updatedAt: Date.now() })
        return 'sent'
      },
      async get(cmdId) {
        return envelopes.get(cmdId) ?? null
      },
    },
  }
  return { ports, records, deliveries }
}

function environmentControlScenarios(): Scenario[] {
  const out: Scenario[] = []
  const P = ids.printerA1
  const listOp = 'GET /environment/controls'
  const submitOp = 'POST /environment/controls/{printerId}/actions'
  const readOp = 'GET /environment/controls/{printerId}/actions/{actionId}'
  const farmGrant = (scopes: IntegrationScope[], requiresApproval = false) => [
    { scopes, requiresApproval },
  ]
  const send = async (input: Outcome['input']): Promise<Outcome> => ({
    input,
    result: await call(input),
  })
  /** A fresh observation of an idle printer with a reported chamber fan. */
  const freshExtraction = (world: World, printerId = P) => {
    world.authStore.printers = world.authStore.printers.map((row) =>
      row.id === printerId
        ? {
            ...row,
            state: {
              ...(row.state as Record<string, unknown>),
              state: 'idle',
              progress: 0,
              fans: { chamber: 40 },
              observedAt: Date.now(),
            },
          }
        : row,
    )
  }
  const withPorts = (
    outcome?: Parameters<typeof memoryEnvironmentPorts>[0],
  ) => {
    const memory = memoryEnvironmentPorts(outcome)
    setIntegrationEnvironmentControlPorts(memory.ports)
    return memory
  }
  const extraction = (percent = 60) => ({
    control: 'extraction',
    action: 'set',
    args: { percent },
  })
  const submit = (
    printerId: string = P,
    body: unknown = extraction(),
    headers: Record<string, string> = {
      'idempotency-key': `key-${crypto.randomUUID()}`,
    },
  ) => ({
    method: 'POST',
    path: `/environment/controls/${printerId}/actions`,
    headers,
    body: body as Record<string, unknown>,
  })
  const asApp = async (
    world: World,
    grants: Parameters<World['addApp']>[0],
    input: (app: App) => Outcome['input'],
    scope?: string,
  ) => {
    const app = world.addApp(grants)
    const token = await tokenFor(world, app, scope)
    return send({ ...input(app), token })
  }
  const add = (
    op: string,
    status: string,
    name: string,
    run: Scenario['run'],
  ) => out.push({ op, status, name, run })
  /** Seeds a submitted action of `app` with the given Connector outcome. */
  const seedAction = async (
    world: World,
    app: App,
    outcome?: Parameters<typeof memoryEnvironmentPorts>[0],
  ) => {
    freshExtraction(world)
    withPorts(outcome)
    const token = await tokenFor(world, app)
    const created = await send({ ...submit(), token })
    return { token, action: created.result.json as { id: string } }
  }
  const read = (printerId: string, actionId: string) => ({
    method: 'GET',
    path: `/environment/controls/${printerId}/actions/${actionId}`,
  })

  const commonAuth = (
    op: string,
    scopes: IntegrationScope[],
    valid: (world: World, app: App) => Promise<Outcome['input']>,
  ) => {
    const grants = farmGrant(scopes)
    add(op, '401', 'no token', async (world) => {
      const app = world.addApp(grants)
      return send(await valid(world, app))
    })
    add(op, '401', 'malformed token', async (world) => {
      const app = world.addApp(grants)
      return send({ ...(await valid(world, app)), token: 'not-a-token' })
    })
    add(
      op,
      '401',
      'grants revoked after the token was issued',
      async (world) => {
        const app = world.addApp(grants)
        const input = await valid(world, app)
        const token = await tokenFor(world, app)
        world.disableGrants(app)
        return send({ ...input, token })
      },
    )
    add(
      op,
      '403',
      'app holds no grant with the required scope',
      async (world) => {
        const app = world.addApp(farmGrant(['printers:read']))
        const input = await valid(world, app)
        return send({ ...input, token: await tokenFor(world, app) })
      },
    )
    add(op, '403', 'token narrowed to another scope', async (world) => {
      const app = world.addApp(farmGrant([...scopes, 'printers:read']))
      const input = await valid(world, app)
      return send({
        ...input,
        token: await tokenFor(world, app, 'printers:read'),
      })
    })
    add(op, '405', 'method the path does not accept', async (world) => {
      const app = world.addApp(grants)
      const input = await valid(world, app)
      return send({
        method: 'PUT',
        path: input.path.split('?')[0]!,
        token: await tokenFor(world, app),
      })
    })
    add(op, '429', 'per-app request limit reached', async (world) => {
      const app = world.addApp(grants)
      const token = await tokenFor(world, app)
      const input = await valid(world, app)
      world.config.integrationAuth.readLimit = 1
      world.config.integrationAuth.writeLimit = 1
      await send({ ...input, token })
      return send({ ...input, token })
    })
    add(op, '503', 'authorization store unavailable', async (world) => {
      const app = world.addApp(grants)
      const token = await tokenFor(world, app)
      const input = await valid(world, app)
      world.faults.add('auth-store')
      return send({ ...input, token })
    })
  }

  // GET /environment/controls
  const list = () => ({ method: 'GET', path: '/environment/controls?limit=1' })
  add(listOp, '200', 'environment:read lists readiness and links', (world) =>
    asApp(world, farmGrant(['environment:read']), list),
  )
  add(listOp, '200', 'environment:control lists qualified actions', (world) => {
    freshExtraction(world)
    return asApp(world, farmGrant(['environment:control']), list)
  })
  add(listOp, '200', 'second page through nextCursor', async (world) => {
    const app = world.addApp(farmGrant(['environment:read']))
    const token = await tokenFor(world, app)
    const first = await send({ ...list(), token })
    const cursor = (first.result.json as { nextCursor: string }).nextCursor
    return send({
      method: 'GET',
      path: `/environment/controls?limit=1&cursor=${cursor}`,
      token,
    })
  })
  add(listOp, '400', 'malformed request', (world) =>
    asApp(world, farmGrant(['environment:read']), () => ({
      method: 'GET',
      path: '/environment/controls?limit=0',
    })),
  )
  add(listOp, '404', 'farm outside the grants', (world) =>
    asApp(world, farmGrant(['environment:read']), () => ({
      method: 'GET',
      path: `/environment/controls?farmId=${ids.unknown}`,
    })),
  )
  add(listOp, '503', 'printers unavailable', async (world) => {
    const app = world.addApp(farmGrant(['environment:read']))
    const token = await tokenFor(world, app)
    world.faults.add('printers')
    return send({ ...list(), token })
  })
  commonAuth(listOp, ['environment:read'], async () => list())

  // POST /environment/controls/{printerId}/actions
  add(submitOp, '202', 'extraction set on a ready printer', async (world) => {
    freshExtraction(world)
    withPorts()
    return asApp(world, farmGrant(['environment:control']), () => submit())
  })
  add(
    submitOp,
    '202',
    'replay with the same key returns the action',
    async (world) => {
      freshExtraction(world)
      const memory = withPorts()
      const app = world.addApp(farmGrant(['environment:control']))
      const token = await tokenFor(world, app)
      const input = submit()
      await send({ ...input, token })
      const replay = await send({ ...input, token })
      expect(memory.deliveries).toHaveLength(1)
      return replay
    },
  )
  add(submitOp, '400', 'missing Idempotency-Key', (world) =>
    asApp(world, farmGrant(['environment:control']), () =>
      submit(P, extraction(), {}),
    ),
  )
  add(submitOp, '400', 'malformed JSON', (world) =>
    asApp(world, farmGrant(['environment:control']), () => ({
      method: 'POST',
      path: `/environment/controls/${P}/actions`,
      headers: {
        'idempotency-key': 'key-malformed',
        'content-type': 'application/json',
      },
      body: '{',
    })),
  )
  add(submitOp, '404', 'unknown printer', (world) =>
    asApp(world, farmGrant(['environment:control']), () => submit(ids.unknown)),
  )
  add(submitOp, '404', 'grant limited to another printer', (world) =>
    asApp(
      world,
      [{ scopes: ['environment:control'], printerId: ids.printerA2 }],
      () => submit(),
    ),
  )
  add(submitOp, '404', 'printer of another farm', (world) =>
    asApp(world, farmGrant(['environment:control']), () =>
      submit(ids.printerB1),
    ),
  )
  add(
    submitOp,
    '409',
    'Idempotency-Key reused with another body',
    async (world) => {
      freshExtraction(world)
      withPorts()
      const app = world.addApp(farmGrant(['environment:control']))
      const token = await tokenFor(world, app)
      const headers = { 'idempotency-key': 'key-reused' }
      await send({ ...submit(P, extraction(60), headers), token })
      return send({ ...submit(P, extraction(70), headers), token })
    },
  )
  add(submitOp, '409', 'stale observation sends nothing', async (world) => {
    withPorts()
    return asApp(world, farmGrant(['environment:control']), () => submit())
  })
  add(submitOp, '409', 'offline printer is not ready', async (world) => {
    freshExtraction(world)
    world.authStore.printers = world.authStore.printers.map((row) =>
      row.id === P
        ? {
            ...row,
            state: {
              printerKey: row.printerKey,
              state: 'offline',
              observedAt: Date.now(),
            },
          }
        : row,
    )
    withPorts()
    return asApp(world, farmGrant(['environment:control']), () => submit())
  })
  add(submitOp, '413', 'body over the limit', (world) =>
    asApp(world, farmGrant(['environment:control']), () =>
      submit(P, { ...extraction(), pad: 'x'.repeat(8 * 1024) }),
    ),
  )
  add(submitOp, '415', 'body is not JSON', (world) =>
    asApp(world, farmGrant(['environment:control']), () => ({
      method: 'POST',
      path: `/environment/controls/${P}/actions`,
      headers: { 'idempotency-key': 'key-text', 'content-type': 'text/plain' },
      body: 'percent=60',
    })),
  )
  add(
    submitOp,
    '422',
    'smart plug has no qualified capability',
    async (world) => {
      freshExtraction(world)
      const memory = withPorts()
      const outcome = await asApp(
        world,
        farmGrant(['environment:control']),
        () =>
          submit(P, {
            control: 'plug',
            action: 'off',
            args: { device: 'printer' },
          }),
      )
      expect(memory.records).toHaveLength(0)
      expect(outcome.result.json).toMatchObject({
        code: 'unsupported',
        managementUrl: '/impressoras/printer-a1?farm=' + ids.farmA,
      })
      return outcome
    },
  )
  add(
    submitOp,
    '422',
    'drying start has no qualified capability',
    async (world) => {
      freshExtraction(world)
      withPorts()
      return asApp(world, farmGrant(['environment:control']), () =>
        submit(P, {
          control: 'drying',
          action: 'start',
          args: { targetCelsius: 55, durationMinutes: 240 },
        }),
      )
    },
  )
  add(submitOp, '422', 'percent out of range', (world) =>
    asApp(world, farmGrant(['environment:control']), () =>
      submit(P, extraction(101)),
    ),
  )
  add(submitOp, '503', 'action storage not configured', async (world) => {
    freshExtraction(world)
    setIntegrationEnvironmentControlPorts(null)
    return asApp(world, farmGrant(['environment:control']), () => submit())
  })
  commonAuth(submitOp, ['environment:control'], async () => submit())

  // GET /environment/controls/{printerId}/actions/{actionId}
  add(readOp, '200', 'accepted by the Connector', async (world) => {
    const app = world.addApp(farmGrant(['environment:control']))
    const { token, action } = await seedAction(world, app, {
      status: 'completed',
      refusalCode: null,
      resultDetail: null,
    })
    return send({ ...read(P, action.id), token })
  })
  add(readOp, '200', 'refused by the Connector interlock', async (world) => {
    const app = world.addApp(farmGrant(['environment:control']))
    const { token, action } = await seedAction(world, app, {
      status: 'refused',
      refusalCode: 'printer-busy',
      resultDetail: 'extraction-interlock-print-active',
    })
    const outcome = await send({ ...read(P, action.id), token })
    expect(outcome.result.json).toMatchObject({
      outcome: 'refused',
      refusal: {
        code: 'printer-busy',
        detail: 'extraction-interlock-print-active',
      },
    })
    return outcome
  })
  add(readOp, '404', 'unknown action', async (world) => {
    withPorts()
    return asApp(world, farmGrant(['environment:control']), () =>
      read(P, ids.unknown),
    )
  })
  add(readOp, '404', 'action of another printer path', async (world) => {
    const app = world.addApp(farmGrant(['environment:control']))
    const { token, action } = await seedAction(world, app)
    return send({ ...read(ids.printerA2, action.id), token })
  })
  add(readOp, '404', 'action of another app', async (world) => {
    const owner = world.addApp(farmGrant(['environment:control']))
    const { action } = await seedAction(world, owner)
    return asApp(world, farmGrant(['environment:control']), () =>
      read(P, action.id),
    )
  })
  add(readOp, '503', 'action storage not configured', async (world) => {
    setIntegrationEnvironmentControlPorts(null)
    return asApp(world, farmGrant(['environment:control']), () =>
      read(P, ids.unknown),
    )
  })
  commonAuth(readOp, ['environment:control'], async (world, app) => {
    const { action } = await seedAction(world, app)
    return read(P, action.id)
  })
  return out
}

describe('collection hold on the printer action route', () => {
  it('shows the plate, accepts confirm_collection, and refuses the wrong scope', async () => {
    const world = freshWorld()
    const printer = world.authStore.printers.find(
      (row) => row.id === ids.printerA1,
    )!
    printer.state = {
      printerKey: printer.printerKey,
      state: 'idle',
      progress: 0,
      observedAt: 1_700_000_000_000,
      controls: ['pause', 'resume', 'cancel', 'confirm_collection'],
      lastJob: { outcome: 'completed', endedAt: 5000 },
    }
    const target = world.actionsStore.targets.get(ids.printerA1)!
    target.controls = ['pause', 'resume', 'cancel', 'confirm_collection']
    const token = await tokenFor(
      world,
      world.addApp([{ scopes: ['printers:read', 'plates:confirm'] }]),
    )
    const basic = await tokenFor(
      world,
      world.addApp([{ scopes: ['control:basic'] }]),
    )
    const status = await call({
      method: 'GET',
      path: `/printers/${ids.printerA1}/status`,
      token,
    })
    expect(status.status).toBe(200)
    expect(status.json).toMatchObject({
      state: 'idle',
      plate: { state: 'awaiting-collection', attemptId: '5000' },
    })
    expect(
      validateValue(
        resolveRef('#/components/schemas/PrinterStatus'),
        status.json,
      ),
    ).toEqual([])
    const clear = await call({
      method: 'GET',
      path: `/printers/${ids.printerA2}/status`,
      token,
    })
    expect(clear.status).toBe(200)
    expect(clear.json).not.toHaveProperty('plate')

    const confirm = {
      method: 'POST',
      path: `/printers/${ids.printerA1}/actions`,
      headers: { 'idempotency-key': 'collect-bed' },
      body: { action: 'confirm_collection', args: { attempt: '5000' } },
    }
    const refused = await call({ ...confirm, token: basic })
    expect(refused.status).toBe(403)
    expect(refused.json).toMatchObject({ code: 'insufficient-scope' })
    const pause = await call({
      method: 'POST',
      path: `/printers/${ids.printerA1}/actions`,
      token,
      headers: { 'idempotency-key': 'not-basic' },
      body: { action: 'pause', args: {} },
    })
    expect(pause.status).toBe(403)
    expect(pause.json).toMatchObject({ code: 'insufficient-scope' })

    const accepted = await call({ ...confirm, token })
    expect(accepted.status).toBe(202)
    expect(accepted.json).toMatchObject({
      action: 'confirm_collection',
      args: { attempt: '5000' },
      status: 'queued',
    })
    expect(
      validateValue(resolveRef('#/components/schemas/Action'), accepted.json),
    ).toEqual([])
    const actionId = (accepted.json as { id: string }).id
    const envelope = world.envelopes.byResource(actionId)!
    expect(envelope.requiredScope).toBe('plates:confirm')
    expect(world.envelopes.commands.get(envelope.cmdId)).toMatchObject({
      kind: 'action',
      action: {
        action: 'confirm_collection',
        args: { attempt: '5000' },
      },
    })
    const replay = await call({ ...confirm, token })
    expect(replay.status).toBe(202)
    expect(replay.json).toMatchObject({ id: actionId, status: 'queued' })
    expect(replay.headers.get('location')).toBe(
      accepted.headers.get('location'),
    )
  })
})
