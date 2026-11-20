// One scenario per (operation, documented status). The contract test walks the
// spec and fails for any operation/status pair that has no scenario here, so a
// path or response added to docs/api/openapi-v1.yaml is untested until covered.
//
// Operations are described once in `fixtures`; the generic scenarios (401, 403,
// 405, 429, 503 through the auth store, scope and revocation cases) are
// derived from each fixture, and `extra` adds the operation-specific ones.
import type { IntegrationScope } from '../../../apps/farm/server/services/integration-apps.ts'
import { call, type CallInput, type CallResult } from './router.ts'
import { ids, jobBody, type App, type Fault, type World } from './world.ts'

export interface Outcome {
  input: CallInput
  result: CallResult
}
export interface Scenario {
  op: string
  status: string
  name: string
  run: (world: World) => Promise<Outcome>
}

type Grants = Parameters<World['addApp']>[0]

async function send(input: CallInput): Promise<Outcome> {
  return { input, result: await call(input) }
}

export async function tokenFor(
  world: World,
  app: App,
  scope?: string,
): Promise<string> {
  void world
  const basic = Buffer.from(`${app.clientId}:${app.secret}`).toString('base64')
  const { result } = await send({
    method: 'POST',
    path: '/oauth/token',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body:
      'grant_type=client_credentials' +
      (scope === undefined ? '' : `&scope=${encodeURIComponent(scope)}`),
  })
  const token = (result.json as { access_token?: string } | undefined)
    ?.access_token
  if (!token)
    throw new Error(`token request failed: ${result.status} ${result.text}`)
  return token
}

const farm = (scopes: IntegrationScope[], requiresApproval = false): Grants => [
  { scopes, requiresApproval },
]
const key = () => `key-${crypto.randomUUID()}`
const json = (
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
) => ({
  headers: { 'idempotency-key': key(), ...extra },
  body,
})

interface Fixture {
  scopes: IntegrationScope[]
  /** Success request; may seed the world for `app`. */
  valid: (world: World, app: App) => CallInput
  success: string
  /** Extra successful variants. */
  more?: { name: string; run: Scenario['run'] }[]
  bad?: (world: World, app: App) => CallInput
  missing?: (world: World, app: App) => CallInput
  /** Request that reaches a handler failure when `fault` is on. */
  fault?: Fault
  /** The path has a printer id, so a grant limited to another printer is a 404. */
  printerPath?: boolean
  /** Extra scenarios keyed by documented status. */
  extra?: Record<string, { name: string; run: Scenario['run'] }[]>
}

const P = ids.printerA1
const seedWebhook = (world: World, app: App) =>
  world.webhooks.seed(app.appId, 1)[0]!.id

async function asApp(
  world: World,
  grants: Grants,
  input: (app: App) => CallInput,
  scope?: string,
  options: { sandbox?: boolean } = {},
): Promise<Outcome> {
  const app = world.addApp(grants, options)
  const token = await tokenFor(world, app, scope)
  return send({ ...input(app), token })
}

export const fixtures: Record<string, Fixture> = {
  'GET /openapi.json': {
    scopes: [],
    success: '200',
    valid: () => ({ method: 'GET', path: '/openapi.json' }),
  },
  'POST /oauth/token': {
    scopes: [],
    success: '200',
    valid: () => ({ method: 'POST', path: '/oauth/token' }),
  },
  'GET /printers': {
    scopes: ['printers:read'],
    success: '200',
    valid: () => ({ method: 'GET', path: '/printers?limit=1' }),
    more: [
      {
        name: 'second page through nextCursor',
        run: async (world) => {
          const app = world.addApp(farm(['printers:read']))
          const token = await tokenFor(world, app)
          const first = await send({
            method: 'GET',
            path: '/printers?limit=1',
            token,
          })
          const cursor = (first.result.json as { nextCursor: string })
            .nextCursor
          return send({
            method: 'GET',
            path: `/printers?limit=1&cursor=${cursor}`,
            token,
          })
        },
      },
      {
        name: 'printer-scoped grant lists only its printer',
        run: (world) =>
          asApp(world, [{ scopes: ['printers:read'], printerId: P }], () => ({
            method: 'GET',
            path: '/printers',
          })),
      },
    ],
    bad: () => ({ method: 'GET', path: '/printers?limit=0' }),
    missing: () => ({ method: 'GET', path: `/printers?farmId=${ids.unknown}` }),
    fault: 'printers',
  },
  'GET /printers/status': {
    scopes: ['printers:read'],
    success: '200',
    valid: () => ({ method: 'GET', path: '/printers/status?limit=1' }),
    more: [
      {
        name: 'second page through nextCursor',
        run: async (world) => {
          const app = world.addApp(farm(['printers:read']))
          const token = await tokenFor(world, app)
          const first = await send({
            method: 'GET',
            path: '/printers/status?limit=1',
            token,
          })
          const cursor = (first.result.json as { nextCursor: string })
            .nextCursor
          return send({
            method: 'GET',
            path: `/printers/status?limit=1&cursor=${cursor}`,
            token,
          })
        },
      },
      {
        name: 'printer-scoped grant lists only its printer',
        run: (world) =>
          asApp(world, [{ scopes: ['printers:read'], printerId: P }], () => ({
            method: 'GET',
            path: '/printers/status',
          })),
      },
    ],
    bad: () => ({ method: 'GET', path: '/printers/status?limit=0' }),
    missing: () => ({
      method: 'GET',
      path: `/printers/status?farmId=${ids.unknown}`,
    }),
    fault: 'printers',
  },
  'GET /printers/{printerId}/status': {
    scopes: ['printers:read'],
    success: '200',
    printerPath: true,
    valid: () => ({ method: 'GET', path: `/printers/${P}/status` }),
    missing: () => ({ method: 'GET', path: `/printers/${ids.unknown}/status` }),
    fault: 'printers',
    extra: {
      '404': [
        {
          name: 'malformed printer id (unknown query params ignored)',
          run: (world) =>
            asApp(world, farm(['printers:read']), () => ({
              method: 'GET',
              path: '/printers/not-a-uuid/status?bogus=1',
            })),
        },
      ],
    },
  },
  'GET /printers/{printerId}/files': {
    scopes: ['files:read'],
    success: '200',
    printerPath: true,
    valid: (world) => {
      world.inbox = {
        kind: 'files',
        data: [
          { name: 'a.gcode', sizeBytes: 10, modifiedAt: 1 },
          { name: 'b/c.gcode', sizeBytes: 20, modifiedAt: 2 },
        ],
        nextOffset: 2,
      }
      return { method: 'GET', path: `/printers/${P}/files?limit=2` }
    },
    bad: () => ({ method: 'GET', path: `/printers/${P}/files?limit=0` }),
    missing: () => ({ method: 'GET', path: `/printers/${ids.unknown}/files` }),
    fault: 'printers',
    extra: {
      '422': [
        {
          name: 'Connector does not support the query',
          run: (world) => {
            world.inbox = { kind: 'error', error: 'unsupported' }
            return asApp(world, farm(['files:read']), () => ({
              method: 'GET',
              path: `/printers/${P}/files`,
            }))
          },
        },
      ],
      '503': [
        {
          name: 'Connector unavailable',
          run: (world) => {
            world.inbox = { kind: 'error', error: 'connector-unavailable' }
            return asApp(world, farm(['files:read']), () => ({
              method: 'GET',
              path: `/printers/${P}/files`,
            }))
          },
        },
      ],
      '504': [
        {
          name: 'Connector timeout',
          run: (world) => {
            world.inbox = { kind: 'error', error: 'connector-timeout' }
            return asApp(world, farm(['files:read']), () => ({
              method: 'GET',
              path: `/printers/${P}/files`,
            }))
          },
        },
      ],
    },
  },
  'GET /printers/{printerId}/macros': {
    scopes: ['control:extended'],
    success: '200',
    printerPath: true,
    valid: (world) => {
      world.inbox = {
        kind: 'macros',
        data: [{ name: 'PURGE' }, { name: 'LOAD_FILAMENT' }],
        nextOffset: null,
      }
      return { method: 'GET', path: `/printers/${P}/macros` }
    },
    bad: () => ({ method: 'GET', path: `/printers/${P}/macros?limit=0` }),
    missing: () => ({ method: 'GET', path: `/printers/${ids.unknown}/macros` }),
    fault: 'printers',
    extra: {
      '422': [
        {
          name: 'Connector does not support macros',
          run: (world) => {
            world.inbox = { kind: 'error', error: 'unsupported' }
            return asApp(world, farm(['control:extended']), () => ({
              method: 'GET',
              path: `/printers/${P}/macros`,
            }))
          },
        },
      ],
      '503': [
        {
          name: 'Connector unavailable',
          run: (world) => {
            world.inbox = { kind: 'error', error: 'connector-unavailable' }
            return asApp(world, farm(['control:extended']), () => ({
              method: 'GET',
              path: `/printers/${P}/macros`,
            }))
          },
        },
      ],
      '504': [
        {
          name: 'Connector timeout',
          run: (world) => {
            world.inbox = { kind: 'error', error: 'connector-timeout' }
            return asApp(world, farm(['control:extended']), () => ({
              method: 'GET',
              path: `/printers/${P}/macros`,
            }))
          },
        },
      ],
    },
  },
  'POST /printers/{printerId}/jobs': {
    scopes: ['jobs:start'],
    success: '202',
    printerPath: true,
    valid: () => ({
      method: 'POST',
      path: `/printers/${P}/jobs`,
      ...json(jobBody),
    }),
    more: [
      {
        name: 'grant requiring approval holds the job',
        run: (world) =>
          asApp(world, farm(['jobs:start'], true), () => ({
            method: 'POST',
            path: `/printers/${P}/jobs`,
            ...json(jobBody),
          })),
      },
      {
        name: 'library replay in connector storage mode',
        run: (world) =>
          asApp(world, farm(['jobs:start', 'jobs:write']), () => ({
            method: 'POST',
            path: `/printers/${P}/jobs`,
            ...json({ libraryVersionId: ids.versionA }),
          })),
      },
      {
        name: 'library replay in server storage mode',
        run: (world) =>
          asApp(world, farm(['jobs:start', 'jobs:write']), () => ({
            method: 'POST',
            path: `/printers/${P}/jobs`,
            ...json({ libraryVersionId: ids.versionServer, plate: 1 }),
          })),
      },
      {
        name: 'replay of the same key and body returns the job again',
        run: async (world) => {
          const app = world.addApp(farm(['jobs:start']))
          const token = await tokenFor(world, app)
          const request = {
            method: 'POST',
            path: `/printers/${P}/jobs`,
            ...json(jobBody),
            token,
          }
          await send(request)
          return send(request)
        },
      },
    ],
    bad: () => ({
      method: 'POST',
      path: `/printers/${P}/jobs`,
      headers: {},
      body: jobBody,
    }),
    missing: () => ({
      method: 'POST',
      path: `/printers/${ids.unknown}/jobs`,
      ...json(jobBody),
    }),
    fault: 'jobs-runtime',
    extra: {
      '409': [
        {
          name: 'idempotency key reused with another body',
          run: async (world) => {
            const app = world.addApp(farm(['jobs:start']))
            const token = await tokenFor(world, app)
            const idem = { 'idempotency-key': key() }
            await send({
              method: 'POST',
              path: `/printers/${P}/jobs`,
              headers: idem,
              body: jobBody,
              token,
            })
            return send({
              method: 'POST',
              path: `/printers/${P}/jobs`,
              headers: idem,
              body: { ...jobBody, sizeBytes: jobBody.sizeBytes + 1 },
              token,
            })
          },
        },
      ],
      '413': [
        {
          name: 'body over 16 KiB',
          run: (world) =>
            asApp(world, farm(['jobs:start']), () => ({
              method: 'POST',
              path: `/printers/${P}/jobs`,
              headers: {
                'idempotency-key': key(),
                'content-type': 'application/json',
              },
              body: JSON.stringify({ x: 'a'.repeat(17 * 1024) }),
            })),
        },
      ],
      '415': [
        {
          name: 'not JSON',
          run: (world) =>
            asApp(world, farm(['jobs:start']), () => ({
              method: 'POST',
              path: `/printers/${P}/jobs`,
              headers: {
                'idempotency-key': key(),
                'content-type': 'text/plain',
              },
              body: JSON.stringify(jobBody),
            })),
        },
      ],
      '422': [
        {
          name: 'file URL is not HTTPS',
          run: (world) =>
            asApp(world, farm(['jobs:start']), () => ({
              method: 'POST',
              path: `/printers/${P}/jobs`,
              ...json({
                ...jobBody,
                fileUrl: 'http://files.example.invalid/x.gcode',
              }),
            })),
        },
      ],
    },
  },
  'POST /printers/{printerId}/actions': {
    scopes: ['control:basic', 'control:extended'],
    success: '202',
    printerPath: true,
    valid: () => ({
      method: 'POST',
      path: `/printers/${P}/actions`,
      ...json({ action: 'pause', args: {} }),
    }),
    more: [
      {
        name: 'extended action with arguments',
        run: (world) =>
          asApp(world, farm(['control:extended']), () => ({
            method: 'POST',
            path: `/printers/${P}/actions`,
            ...json({
              action: 'set_temperature',
              args: { heater: 'bed', targetCelsius: 60 },
            }),
          })),
      },
      {
        name: 'grant requiring approval holds the action',
        run: (world) =>
          asApp(world, farm(['control:basic'], true), () => ({
            method: 'POST',
            path: `/printers/${P}/actions`,
            ...json({ action: 'resume', args: {} }),
          })),
      },
    ],
    bad: () => ({
      method: 'POST',
      path: `/printers/${P}/actions`,
      headers: {},
      body: { action: 'pause', args: {} },
    }),
    missing: () => ({
      method: 'POST',
      path: `/printers/${ids.unknown}/actions`,
      ...json({ action: 'pause', args: {} }),
    }),
    fault: 'jobs-runtime',
    extra: {
      '409': [
        {
          name: 'idempotency key reused with another action',
          run: async (world) => {
            const app = world.addApp(farm(['control:basic']))
            const token = await tokenFor(world, app)
            const idem = { 'idempotency-key': key() }
            await send({
              method: 'POST',
              path: `/printers/${P}/actions`,
              headers: idem,
              body: { action: 'pause', args: {} },
              token,
            })
            return send({
              method: 'POST',
              path: `/printers/${P}/actions`,
              headers: idem,
              body: { action: 'resume', args: {} },
              token,
            })
          },
        },
      ],
      '413': [
        {
          name: 'body over 64 KiB',
          run: (world) =>
            asApp(world, farm(['control:basic']), () => ({
              method: 'POST',
              path: `/printers/${P}/actions`,
              headers: {
                'idempotency-key': key(),
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                action: 'pause',
                args: {},
                x: 'a'.repeat(65 * 1024),
              }),
            })),
        },
      ],
      '415': [
        {
          name: 'not JSON',
          run: (world) =>
            asApp(world, farm(['control:basic']), () => ({
              method: 'POST',
              path: `/printers/${P}/actions`,
              headers: {
                'idempotency-key': key(),
                'content-type': 'text/plain',
              },
              body: JSON.stringify({ action: 'pause', args: {} }),
            })),
        },
      ],
      '422': [
        {
          name: 'arguments fail validation',
          run: (world) =>
            asApp(world, farm(['control:extended']), () => ({
              method: 'POST',
              path: `/printers/${P}/actions`,
              ...json({ action: 'set_fan', args: { fan: 'part' } }),
            })),
        },
        {
          name: 'printer does not advertise the action',
          run: (world) => {
            world.actionsStore.targets.set(P, {
              farmId: ids.farmA,
              agentId: ids.agentA,
              controls: ['pause'],
            })
            return asApp(world, farm(['control:extended']), () => ({
              method: 'POST',
              path: `/printers/${P}/actions`,
              ...json({ action: 'home', args: { axes: ['x'] } }),
            }))
          },
        },
      ],
    },
  },
  'GET /inventory': {
    scopes: ['inventory:read'],
    success: '200',
    valid: () => ({ method: 'GET', path: '/inventory?limit=1' }),
    more: [
      {
        name: 'second page through nextCursor',
        run: async (world) => {
          const app = world.addApp(farm(['inventory:read']))
          const token = await tokenFor(world, app)
          const first = await send({
            method: 'GET',
            path: '/inventory?limit=1',
            token,
          })
          const cursor = (first.result.json as { nextCursor: string })
            .nextCursor
          return send({
            method: 'GET',
            path: `/inventory?limit=1&cursor=${cursor}`,
            token,
          })
        },
      },
    ],
    bad: () => ({ method: 'GET', path: '/inventory?limit=0' }),
    missing: () => ({
      method: 'GET',
      path: `/inventory?farmId=${ids.unknown}`,
    }),
    fault: 'pool',
  },
  'GET /jobs': {
    scopes: ['jobs:read'],
    success: '200',
    valid: () => ({ method: 'GET', path: '/jobs?limit=2' }),
    more: [
      {
        name: 'second page through nextCursor',
        run: async (world) => {
          const app = world.addApp(farm(['jobs:read']))
          const token = await tokenFor(world, app)
          const first = await send({
            method: 'GET',
            path: '/jobs?limit=2',
            token,
          })
          const cursor = (first.result.json as { nextCursor: string })
            .nextCursor
          return send({
            method: 'GET',
            path: `/jobs?limit=2&cursor=${cursor}`,
            token,
          })
        },
      },
      {
        name: 'filtered by printer and time window',
        run: (world) =>
          asApp(world, farm(['jobs:read']), () => ({
            method: 'GET',
            path: `/jobs?printerId=${P}&since=0&until=${world.clock + 1}`,
          })),
      },
    ],
    bad: () => ({ method: 'GET', path: '/jobs?limit=0' }),
    missing: () => ({ method: 'GET', path: `/jobs?farmId=${ids.unknown}` }),
    fault: 'pool',
  },
  'GET /jobs/{jobId}': {
    scopes: ['jobs:read'],
    success: '200',
    valid: (world, app) => ({
      method: 'GET',
      path: `/jobs/${world.seedJob(app).id}`,
    }),
    more: [
      {
        name: 'job the Connector refused carries its refusal',
        run: (world) =>
          asApp(world, farm(['jobs:read']), (app) => ({
            method: 'GET',
            path: `/jobs/${
              world.seedJob(
                app,
                {},
                {
                  appId: app.appId,
                  status: 'refused',
                  refusalCode: 'printer-busy',
                  resultDetail: 'printing',
                },
              ).id
            }`,
          })),
      },
      {
        name: 'finished job carries its history entry',
        run: (world) =>
          asApp(world, farm(['jobs:read']), (app) => ({
            method: 'GET',
            path: `/jobs/${
              world.seedJob(
                app,
                {},
                {
                  appId: app.appId,
                  status: 'completed',
                  historyEntryId: '101',
                },
              ).id
            }`,
          })),
      },
      {
        name: 'held job',
        run: (world) =>
          asApp(world, farm(['jobs:start'], true), (app) => ({
            method: 'GET',
            path: `/jobs/${world.seedJob(app, { status: 'held' }).id}`,
          })),
      },
    ],
    missing: () => ({ method: 'GET', path: `/jobs/${ids.unknown}` }),
    fault: 'jobs-runtime',
    extra: {
      '404': [
        {
          name: 'malformed job id',
          run: (world) =>
            asApp(world, farm(['jobs:read']), () => ({
              method: 'GET',
              path: '/jobs/not-a-uuid',
            })),
        },
      ],
    },
  },
  'GET /actions/{actionId}': {
    scopes: ['control:basic'],
    success: '200',
    valid: (world, app) => ({
      method: 'GET',
      path: `/actions/${world.seedAction(app).id}`,
    }),
    more: [
      {
        name: 'action the Connector refused carries its refusal',
        run: (world) =>
          asApp(world, farm(['control:basic']), (app) => ({
            method: 'GET',
            path: `/actions/${
              world.seedAction(
                app,
                {},
                {
                  appId: app.appId,
                  status: 'refused',
                  refusalCode: 'wrong-state',
                },
              ).id
            }`,
          })),
      },
      {
        name: 'extended action reports its arguments as submitted',
        run: (world) =>
          asApp(world, farm(['control:extended']), (app) => ({
            method: 'GET',
            path: `/actions/${
              world.seedAction(
                app,
                {
                  action: {
                    action: 'set_temperature',
                    args: { heater: 'bed', target_c: 60 },
                  } as never,
                  requiredScope: 'control:extended',
                },
                { appId: app.appId, status: 'completed' },
              ).id
            }`,
          })),
      },
    ],
    missing: () => ({ method: 'GET', path: `/actions/${ids.unknown}` }),
    fault: 'jobs-runtime',
    extra: {
      '404': [
        {
          name: 'malformed action id',
          run: (world) =>
            asApp(world, farm(['control:basic']), () => ({
              method: 'GET',
              path: '/actions/not-a-uuid',
            })),
        },
      ],
    },
  },
  'GET /webhooks': {
    scopes: ['events:subscribe'],
    success: '200',
    valid: (world, app) => {
      world.webhooks.seed(app.appId, 2)
      return { method: 'GET', path: '/webhooks?limit=1' }
    },
    more: [
      {
        name: 'second page through nextCursor',
        run: async (world) => {
          const app = world.addApp(farm(['events:subscribe']))
          world.webhooks.seed(app.appId, 2)
          const token = await tokenFor(world, app)
          const first = await send({
            method: 'GET',
            path: '/webhooks?limit=1',
            token,
          })
          const cursor = (first.result.json as { nextCursor: string })
            .nextCursor
          return send({
            method: 'GET',
            path: `/webhooks?limit=1&cursor=${cursor}`,
            token,
          })
        },
      },
    ],
    bad: () => ({ method: 'GET', path: '/webhooks?limit=0' }),
    fault: 'webhooks',
  },
  'POST /webhooks': {
    scopes: ['events:subscribe'],
    success: '201',
    valid: () => ({
      method: 'POST',
      path: '/webhooks',
      body: {
        url: 'https://8.8.8.8/hook',
        events: ['job.ended', 'inventory.changed'],
        description: 'Contract test',
      },
    }),
    bad: () => ({
      method: 'POST',
      path: '/webhooks',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }),
    fault: 'webhooks',
    extra: {
      '409': [
        {
          name: 'subscription limit reached',
          run: async (world) => {
            const app = world.addApp(farm(['events:subscribe']))
            world.webhooks.seed(app.appId, 20)
            const token = await tokenFor(world, app)
            return send({
              method: 'POST',
              path: '/webhooks',
              body: { url: 'https://8.8.8.8/hook', events: ['job.ended'] },
              token,
            })
          },
        },
      ],
      '413': [
        {
          name: 'body over 16 KiB',
          run: (world) =>
            asApp(world, farm(['events:subscribe']), () => ({
              method: 'POST',
              path: '/webhooks',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ x: 'a'.repeat(17 * 1024) }),
            })),
        },
      ],
      '415': [
        {
          name: 'not JSON',
          run: (world) =>
            asApp(world, farm(['events:subscribe']), () => ({
              method: 'POST',
              path: '/webhooks',
              headers: { 'content-type': 'text/plain' },
              body: '{}',
            })),
        },
      ],
      '422': [
        {
          name: 'unknown event type',
          run: (world) =>
            asApp(world, farm(['events:subscribe']), () => ({
              method: 'POST',
              path: '/webhooks',
              body: { url: 'https://8.8.8.8/hook', events: ['nope'] },
            })),
        },
        {
          name: 'target resolves to a private address',
          run: (world) =>
            asApp(world, farm(['events:subscribe']), () => ({
              method: 'POST',
              path: '/webhooks',
              body: { url: 'https://127.0.0.1/hook', events: ['job.ended'] },
            })),
        },
      ],
    },
  },
  'DELETE /webhooks/{webhookId}': {
    scopes: ['events:subscribe'],
    success: '204',
    valid: (world, app) => ({
      method: 'DELETE',
      path: `/webhooks/${seedWebhook(world, app)}`,
    }),
    bad: () => ({ method: 'DELETE', path: '/webhooks/not-a-uuid' }),
    missing: () => ({ method: 'DELETE', path: `/webhooks/${ids.unknown}` }),
    fault: 'webhooks',
  },
  'POST /webhooks/{webhookId}/test': {
    scopes: ['events:subscribe'],
    success: '202',
    valid: (world, app) => ({
      method: 'POST',
      path: `/webhooks/${seedWebhook(world, app)}/test`,
    }),
    bad: () => ({ method: 'POST', path: '/webhooks/not-a-uuid/test' }),
    missing: () => ({ method: 'POST', path: `/webhooks/${ids.unknown}/test` }),
    fault: 'webhooks',
  },
  'GET /library': {
    scopes: ['library:read'],
    success: '200',
    valid: () => ({
      method: 'GET',
      path: `/library?farmId=${ids.farmA}&limit=1`,
    }),
    more: [
      {
        name: 'second page through nextCursor',
        run: async (world) => {
          const app = world.addApp(farm(['library:read']))
          const token = await tokenFor(world, app)
          const first = await send({
            method: 'GET',
            path: `/library?farmId=${ids.farmA}&limit=1`,
            token,
          })
          const cursor = (first.result.json as { nextCursor: string })
            .nextCursor
          return send({
            method: 'GET',
            path: `/library?farmId=${ids.farmA}&limit=1&cursor=${cursor}`,
            token,
          })
        },
      },
    ],
    bad: () => ({
      method: 'GET',
      path: `/library?farmId=${ids.farmA}&limit=0`,
    }),
    missing: () => ({
      method: 'GET',
      path: `/library?farmId=${ids.farmB}`,
    }),
    fault: 'library-runtime',
  },
  'POST /library': {
    scopes: ['library:write'],
    success: '201',
    valid: () => ({
      method: 'POST',
      path: '/library',
      body: libraryUpload(ids.farmA),
    }),
    more: [
      {
        name: 'server storage mode keeps the upload',
        run: async (world) => {
          world.libraryStore.modes.set(ids.farmA, 'server')
          return asApp(world, farm(['library:write']), () => ({
            method: 'POST',
            path: '/library',
            body: libraryUpload(ids.farmA, 'server-part.gcode'),
          }))
        },
      },
    ],
    bad: () => ({
      method: 'POST',
      path: '/library',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }),
    missing: () => ({
      method: 'POST',
      path: '/library',
      body: libraryUpload(ids.farmB),
    }),
    fault: 'library-runtime',
    extra: {
      '413': [
        {
          name: 'file over the configured limit',
          run: (world) => {
            world.config.library = { maxUploadBytes: 8 }
            return asApp(world, farm(['library:write']), () => ({
              method: 'POST',
              path: '/library',
              body: libraryUpload(ids.farmA),
            }))
          },
        },
      ],
      '415': [
        {
          name: 'not JSON',
          run: (world) =>
            asApp(world, farm(['library:write']), () => ({
              method: 'POST',
              path: '/library',
              headers: { 'content-type': 'text/plain' },
              body: '{}',
            })),
        },
        {
          name: 'file is not gcode or 3mf',
          run: (world) =>
            asApp(world, farm(['library:write']), () => ({
              method: 'POST',
              path: '/library',
              body: { ...libraryUpload(ids.farmA), name: 'notes.txt' },
            })),
        },
      ],
      '422': [
        {
          name: '3mf project cannot be read',
          run: (world) =>
            asApp(world, farm(['library:write']), () => ({
              method: 'POST',
              path: '/library',
              body: {
                farmId: ids.farmA,
                name: 'bad.3mf',
                contentBase64: Buffer.from('not a 3mf').toString('base64'),
              },
            })),
        },
      ],
    },
  },
  'GET /library/settings': {
    scopes: ['library:read'],
    success: '200',
    valid: () => ({
      method: 'GET',
      path: `/library/settings?farmId=${ids.farmA}`,
    }),
    bad: () => ({ method: 'GET', path: '/library/settings' }),
    missing: () => ({
      method: 'GET',
      path: `/library/settings?farmId=${ids.farmB}`,
    }),
    fault: 'library-runtime',
  },
  'PATCH /library/settings': {
    scopes: ['library:write'],
    success: '200',
    valid: () => ({
      method: 'PATCH',
      path: '/library/settings',
      body: { farmId: ids.farmA, storageMode: 'server' },
    }),
    bad: () => ({
      method: 'PATCH',
      path: '/library/settings',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }),
    missing: () => ({
      method: 'PATCH',
      path: '/library/settings',
      body: { farmId: ids.farmB, storageMode: 'server' },
    }),
    fault: 'library-runtime',
    extra: {
      '413': [
        {
          name: 'body over 16 KiB',
          run: (world) =>
            asApp(world, farm(['library:write']), () => ({
              method: 'PATCH',
              path: '/library/settings',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ x: 'a'.repeat(17 * 1024) }),
            })),
        },
      ],
      '415': [
        {
          name: 'not JSON',
          run: (world) =>
            asApp(world, farm(['library:write']), () => ({
              method: 'PATCH',
              path: '/library/settings',
              headers: { 'content-type': 'text/plain' },
              body: '{}',
            })),
        },
      ],
      '422': [
        {
          name: 'unknown storage mode',
          run: (world) =>
            asApp(world, farm(['library:write']), () => ({
              method: 'PATCH',
              path: '/library/settings',
              body: { farmId: ids.farmA, storageMode: 'cloud' },
            })),
        },
      ],
    },
  },
  'GET /library/{itemId}': {
    scopes: ['library:read'],
    success: '200',
    valid: () => ({ method: 'GET', path: `/library/${ids.itemB}` }),
    bad: () => ({ method: 'GET', path: '/library/not-a-uuid' }),
    missing: () => ({ method: 'GET', path: `/library/${ids.unknown}` }),
    fault: 'library-runtime',
  },
}

const GCODE = `; generated by OrcaSlicer 2.1
; printer_model = Ender 3
; nozzle_diameter = 0.4
; filament_type = PLA
; filament used [g] = 2
; layer_height = 0.2
G1 X1
`
function libraryUpload(farmId: string, name = 'part.gcode') {
  return {
    farmId,
    name,
    contentBase64: Buffer.from(`${GCODE}; ${name}\n`).toString('base64'),
  }
}

const wrongScope = (scopes: IntegrationScope[]): IntegrationScope =>
  scopes.includes('printers:read') ? 'inventory:read' : 'printers:read'

function authed(op: string, fixture: Fixture) {
  const out: Scenario[] = []
  const add = (status: string, name: string, run: Scenario['run']) =>
    out.push({ op, status, name, run })
  const grants = farm(fixture.scopes)
  const valid = async (world: World, app?: App, token?: string) => {
    const a = app ?? world.addApp(grants)
    const t = token ?? (await tokenFor(world, a))
    return send({ ...fixture.valid(world, a), token: t })
  }

  add(fixture.success, 'documented request succeeds', (world) => valid(world))
  for (const more of fixture.more ?? [])
    add(fixture.success, more.name, more.run)

  add('401', 'no token', async (world) => {
    const app = world.addApp(grants)
    return send(fixture.valid(world, app))
  })
  add('401', 'malformed token', async (world) => {
    const app = world.addApp(grants)
    return send({ ...fixture.valid(world, app), token: 'not-a-token' })
  })
  add('401', 'credential revoked after the token was issued', async (world) => {
    const app = world.addApp(grants)
    const token = await tokenFor(world, app)
    world.revokeCredential(app)
    return send({ ...fixture.valid(world, app), token })
  })
  add('401', 'grants revoked after the token was issued', async (world) => {
    const app = world.addApp(grants)
    const token = await tokenFor(world, app)
    world.disableGrants(app)
    return send({ ...fixture.valid(world, app), token })
  })
  add('401', 'token expired', async (world) => {
    const app = world.addApp(grants)
    const token = await tokenFor(world, app)
    world.clock += 301_000
    return send({ ...fixture.valid(world, app), token })
  })

  const other = wrongScope(fixture.scopes)
  add('403', 'app holds no grant with the required scope', (world) => {
    const app = world.addApp(farm([other]))
    return tokenFor(world, app).then((token) =>
      send({ ...fixture.valid(world, app), token }),
    )
  })
  add('403', 'token narrowed to another scope', async (world) => {
    const app = world.addApp(farm([...fixture.scopes, other]))
    const token = await tokenFor(world, app, other)
    return send({ ...fixture.valid(world, app), token })
  })

  if (fixture.bad)
    add('400', 'malformed request', async (world) => {
      const app = world.addApp(grants)
      const token = await tokenFor(world, app)
      return send({ ...fixture.bad!(world, app), token })
    })
  if (fixture.missing)
    add('404', 'resource outside the grants or unknown', async (world) => {
      const app = world.addApp(grants)
      const token = await tokenFor(world, app)
      return send({ ...fixture.missing!(world, app), token })
    })
  if (fixture.printerPath) {
    add('404', 'grant limited to another printer', async (world) => {
      const app = world.addApp([
        { scopes: fixture.scopes, printerId: ids.printerA2 },
      ])
      const token = await tokenFor(world, app)
      return send({ ...fixture.valid(world, app), token })
    })
    add('404', 'printer of another farm', async (world) => {
      const app = world.addApp(grants)
      const token = await tokenFor(world, app)
      const request = fixture.valid(world, app)
      return send({
        ...request,
        path: request.path.replace(P, ids.printerB1),
        token,
      })
    })
  }

  add('405', 'method the path does not accept', async (world) => {
    const app = world.addApp(grants)
    const token = await tokenFor(world, app)
    const request = fixture.valid(world, app)
    return send({ method: 'PUT', path: request.path.split('?')[0]!, token })
  })

  add('429', 'per-app request limit reached', async (world) => {
    const app = world.addApp(grants)
    const token = await tokenFor(world, app)
    world.config.integrationAuth.readLimit = 1
    world.config.integrationAuth.writeLimit = 1
    await send({ ...fixture.valid(world, app), token })
    return send({ ...fixture.valid(world, app), token })
  })

  add('503', 'authorization store unavailable', async (world) => {
    const app = world.addApp(grants)
    const token = await tokenFor(world, app)
    world.faults.add('auth-store')
    return send({ ...fixture.valid(world, app), token })
  })
  if (fixture.fault)
    add('503', `${fixture.fault} unavailable`, async (world) => {
      const app = world.addApp(grants)
      const token = await tokenFor(world, app)
      const request = fixture.valid(world, app)
      world.faults.add(fixture.fault!)
      return send({ ...request, token })
    })

  for (const [status, list] of Object.entries(fixture.extra ?? {}))
    for (const entry of list) add(status, entry.name, entry.run)
  return out
}

function openapi(): Scenario[] {
  const op = 'GET /openapi.json'
  return [
    {
      op,
      status: '200',
      name: 'public, no token',
      run: () => send({ method: 'GET', path: '/openapi.json' }),
    },
    {
      op,
      status: '4XX',
      name: 'a method other than GET has no v1 route',
      run: () => send({ method: 'POST', path: '/openapi.json' }),
    },
  ]
}

function token(): Scenario[] {
  const op = 'POST /oauth/token'
  const form = 'grant_type=client_credentials'
  const formHeader = { 'content-type': 'application/x-www-form-urlencoded' }
  const basic = (app: App, secret = app.secret) =>
    'Basic ' + Buffer.from(`${app.clientId}:${secret}`).toString('base64')
  return [
    {
      op,
      status: '200',
      name: 'client_secret_basic',
      run: (world) => {
        const app = world.addApp(farm(['printers:read', 'jobs:read']))
        return send({
          method: 'POST',
          path: '/oauth/token',
          headers: { ...formHeader, authorization: basic(app) },
          body: form,
        })
      },
    },
    {
      op,
      status: '200',
      name: 'client_secret_post with a scope subset',
      run: (world) => {
        const app = world.addApp(farm(['printers:read', 'jobs:read']))
        return send({
          method: 'POST',
          path: '/oauth/token',
          headers: formHeader,
          body: `${form}&scope=jobs%3Aread&client_id=${encodeURIComponent(app.clientId)}&client_secret=${encodeURIComponent(app.secret)}`,
        })
      },
    },
    {
      op,
      status: '400',
      name: 'unsupported grant type',
      run: (world) => {
        const app = world.addApp(farm(['printers:read']))
        return send({
          method: 'POST',
          path: '/oauth/token',
          headers: { ...formHeader, authorization: basic(app) },
          body: 'grant_type=password',
        })
      },
    },
    {
      op,
      status: '400',
      name: 'scope the app does not hold',
      run: (world) => {
        const app = world.addApp(farm(['printers:read']))
        return send({
          method: 'POST',
          path: '/oauth/token',
          headers: { ...formHeader, authorization: basic(app) },
          body: `${form}&scope=jobs%3Astart`,
        })
      },
    },
    {
      op,
      status: '400',
      name: 'body is not form encoded',
      run: (world) => {
        const app = world.addApp(farm(['printers:read']))
        return send({
          method: 'POST',
          path: '/oauth/token',
          headers: {
            'content-type': 'application/json',
            authorization: basic(app),
          },
          body: form,
        })
      },
    },
    {
      op,
      status: '401',
      name: 'wrong secret',
      run: (world) => {
        const app = world.addApp(farm(['printers:read']))
        return send({
          method: 'POST',
          path: '/oauth/token',
          headers: { ...formHeader, authorization: basic(app, 'wrong') },
          body: form,
        })
      },
    },
    {
      op,
      status: '401',
      name: 'revoked credential',
      run: (world) => {
        const app = world.addApp(farm(['printers:read']))
        world.revokeCredential(app)
        return send({
          method: 'POST',
          path: '/oauth/token',
          headers: { ...formHeader, authorization: basic(app) },
          body: form,
        })
      },
    },
    {
      op,
      status: '429',
      name: 'more than 30 requests a minute for one client',
      run: async (world) => {
        const app = world.addApp(farm(['printers:read']))
        let last!: Outcome
        for (let attempt = 0; attempt < 31; attempt++)
          last = await send({
            method: 'POST',
            path: '/oauth/token',
            headers: { ...formHeader, authorization: basic(app) },
            body: form,
          })
        return last
      },
    },
    {
      op,
      status: '503',
      name: 'credential store unavailable',
      run: (world) => {
        const app = world.addApp(farm(['printers:read']))
        world.faults.add('auth-store')
        return send({
          method: 'POST',
          path: '/oauth/token',
          headers: { ...formHeader, authorization: basic(app) },
          body: form,
        })
      },
    },
  ]
}

export function allScenarios(): Scenario[] {
  return [
    ...openapi(),
    ...token(),
    ...Object.entries(fixtures)
      .filter(
        ([op]) => op !== 'GET /openapi.json' && op !== 'POST /oauth/token',
      )
      .flatMap(([op, fixture]) => authed(op, fixture)),
  ]
}
