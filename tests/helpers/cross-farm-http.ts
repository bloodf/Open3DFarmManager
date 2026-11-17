// Cross-farm denial over HTTP (issue #222). The real route files run behind a real
// loopback server on an ephemeral port; only the runtime modules that would open
// database pools are replaced with the backend under test. The same scenario runs
// against an in-memory model (tests/node/cross-farm-http.test.ts) and against the
// real PostgreSQL stores (scripts/test-postgres-cross-farm-http.ts).
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { registerHooks } from 'node:module'
import { useSession } from '../../apps/farm/node_modules/nuxt/dist/server/index.js'
import {
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
} from '../../apps/farm/server/utils/auth/boundary.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import { PasswordResetRuntime } from '../../apps/farm/server/utils/auth/password-reset-runtime.ts'
import type { PrinterAssignmentsRuntime } from '../../apps/farm/server/utils/printer-assignments/runtime.ts'
import type { PrinterStateReader } from '../../apps/farm/server/utils/printer-states/runtime.ts'
import type { JobHistoryReader } from '../../apps/farm/server/utils/job-history-runtime.ts'
import type { PostgresConnectorInventory } from '../../apps/farm/server/storage/postgres-connector-inventory.ts'
import type { PostgresConnectorRevocation } from '../../apps/farm/server/storage/postgres-connector-revocation.ts'
import type { ResetLinkStore } from '../../apps/farm/server/services/password-reset-links.ts'
import type { PasswordResetStore } from '../../apps/farm/server/services/password-reset.ts'

export const FOREIGN_FINGERPRINT = 'SHA256:' + 'A'.repeat(43)
const backendToken = Symbol.for('cross-farm-http-backend')

/** Everything a route reaches through its runtime module. */
export interface Backend {
  auth: AuthRuntime
  connectorInventory: Pick<PostgresConnectorInventory, 'listConnectors'>
  printers: PrinterAssignmentsRuntime
  revocation: Pick<PostgresConnectorRevocation, 'revoke'>
  jobHistory: JobHistoryReader
  printerStates: PrinterStateReader
  resetLinks: PasswordResetStore & ResetLinkStore
}
/** The identifiers one farm owns. Farm 0 belongs to account 0, farm 1 to account 1. */
export interface FarmIds {
  farmId: string
  agentId: string
  assignmentId: string
  printerKey: string
  inviteId: string
  memberId: string
}
export interface Scenario {
  backend: Backend
  /** Session record id of account 0 and account 1. */
  sessions: readonly [string, string]
  farms: readonly [FarmIds, FarmIds]
  /** Identifiers that exist in no farm. */
  unknown: FarmIds
  /** Deterministic dump of every farm-scoped row; it must not change under denied calls. */
  snapshot(): Promise<unknown>
}
export interface RouteCase {
  name: string
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  /** Status a non-member observes. */
  denied: number
  /** An own-farm request that succeeds and carries this marker. */
  marker?: (farm: FarmIds) => string
}

export function routeCases(farm: FarmIds): RouteCase[] {
  const base = `/api/farms/${farm.farmId}`
  const printer = {
    agentId: farm.agentId,
    printerKey: farm.printerKey,
    confirmedLocalConfiguration: true,
  }
  return [
    {
      name: 'connectors',
      method: 'GET',
      path: `${base}/connectors`,
      denied: 404,
      marker: (f) => f.agentId,
    },
    {
      name: 'printers list',
      method: 'GET',
      path: `${base}/printers`,
      denied: 404,
      marker: (f) => f.assignmentId,
    },
    {
      name: 'printers register',
      method: 'POST',
      path: `${base}/printers`,
      body: { ...printer, printerKey: 'cross-farm-new-key' },
      denied: 403,
    },
    {
      name: 'printers revoke',
      method: 'POST',
      path: `${base}/printers/${farm.assignmentId}/revoke`,
      body: { agentId: farm.agentId, printerKey: farm.printerKey },
      denied: 403,
    },
    {
      name: 'connector revoke',
      method: 'POST',
      path: `${base}/connectors/${farm.agentId}/revoke`,
      body: { expected_fingerprint: FOREIGN_FINGERPRINT },
      denied: 403,
    },
    {
      name: 'printer states',
      method: 'GET',
      path: `${base}/printer-states`,
      denied: 404,
      marker: (f) => f.printerKey,
    },
    {
      name: 'job history',
      method: 'GET',
      path: `/api/job-history?farmId=${farm.farmId}`,
      denied: 404,
      marker: (f) => f.printerKey,
    },
    {
      name: 'invites list',
      method: 'GET',
      path: `${base}/invites`,
      denied: 404,
      marker: (f) => f.inviteId,
    },
    {
      name: 'invites create',
      method: 'POST',
      path: `${base}/invites`,
      body: { role: 'viewer' },
      denied: 403,
    },
    {
      name: 'invites revoke',
      method: 'POST',
      path: `${base}/invites/${farm.inviteId}/revoke`,
      denied: 404,
    },
    {
      name: 'members list',
      method: 'GET',
      path: `${base}/members`,
      denied: 404,
      marker: (f) => f.memberId,
    },
    {
      name: 'members role',
      method: 'POST',
      path: `${base}/members/${farm.memberId}/role`,
      body: { role: 'admin' },
      denied: 404,
    },
    {
      name: 'members remove',
      method: 'POST',
      path: `${base}/members/${farm.memberId}/remove`,
      denied: 404,
    },
    {
      name: 'members reset link',
      method: 'POST',
      path: `${base}/members/${farm.memberId}/reset-link`,
      denied: 404,
    },
  ]
}

const routeFiles: Array<{
  method: 'GET' | 'POST'
  pattern: RegExp
  names: string[]
  file: string
}> = [
  ['GET', '/api/farms/:farmId/connectors', 'connectors.get.ts'],
  [
    'POST',
    '/api/farms/:farmId/connectors/:agentId/revoke',
    'connectors/[agentId]/revoke.post.ts',
  ],
  ['GET', '/api/farms/:farmId/invites', 'invites/index.get.ts'],
  ['POST', '/api/farms/:farmId/invites', 'invites.post.ts'],
  [
    'POST',
    '/api/farms/:farmId/invites/:inviteId/revoke',
    'invites/[inviteId]/revoke.post.ts',
  ],
  ['GET', '/api/farms/:farmId/members', 'members/index.get.ts'],
  [
    'POST',
    '/api/farms/:farmId/members/:accountId/role',
    'members/[accountId]/role.post.ts',
  ],
  [
    'POST',
    '/api/farms/:farmId/members/:accountId/remove',
    'members/[accountId]/remove.post.ts',
  ],
  [
    'POST',
    '/api/farms/:farmId/members/:accountId/reset-link',
    'members/[accountId]/reset-link.post.ts',
  ],
  ['GET', '/api/farms/:farmId/printers', 'printers.get.ts'],
  ['POST', '/api/farms/:farmId/printers', 'printers.post.ts'],
  [
    'POST',
    '/api/farms/:farmId/printers/:assignmentId/revoke',
    'printers/[assignmentId]/revoke.post.ts',
  ],
  ['GET', '/api/farms/:farmId/printer-states', 'printer-states.get.ts'],
].map(([method, template, file]) => {
  const names: string[] = []
  const source = template!.replace(/:(\w+)/g, (_, name: string) => {
    names.push(name)
    return '([^/]+)'
  })
  return {
    method: method as 'GET' | 'POST',
    pattern: new RegExp(`^${source}$`),
    names,
    file: `farms/[farmId]/${file}`,
  }
})

type Handler = (event: unknown) => Promise<unknown>
const moduleUrl = (source: string) =>
  `data:text/javascript,${encodeURIComponent(source)}`
const backendOf = `globalThis[Symbol.for('cross-farm-http-backend')]()`

/** Replaces only the modules that would open database pools. */
function installRuntimeHooks() {
  const replacements: Record<string, string> = {
    '/utils/auth/runtime.ts': `export const authRuntime = () => ${backendOf}.auth`,
    '/utils/connector-inventory/runtime.ts': `export const connectorInventoryRuntime = () => ${backendOf}.connectorInventory`,
    '/utils/printer-assignments/runtime.ts': `export const printerAssignmentsRuntime = async () => ${backendOf}.printers`,
    '/utils/connector-pairing/runtime.ts': `export const pairingConfiguredOrigin = () => ${backendOf}.auth.origin
      export const connectorPairingRuntime = async () => ({ origin: ${backendOf}.auth.origin, revocation: ${backendOf}.revocation })`,
    '/utils/job-history-runtime.ts': `export const jobHistoryRuntime = () => ${backendOf}.jobHistory`,
    '/utils/printer-states/runtime.ts': `export const printerStatesRuntime = () => ${backendOf}.printerStates`,
  }
  return registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.includes('/server/')) {
        for (const [suffix, source] of Object.entries(replacements))
          if (specifier.endsWith(suffix))
            return { url: moduleUrl(source), shortCircuit: true }
      }
      return next(specifier, context)
    },
  })
}

export interface HttpResult {
  status: number
  text: string
}
export interface CrossFarmServer {
  request(
    session: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<HttpResult>
  close(): Promise<void>
}

/** Serves the real route files on an ephemeral loopback port. */
export async function serveRoutes(backend: Backend): Promise<CrossFarmServer> {
  Object.defineProperty(globalThis, backendToken, {
    configurable: true,
    writable: true,
    value: () => backend,
  })
  const hooks = installRuntimeHooks()
  const handlers = new Map<string, Handler>()
  for (const route of routeFiles)
    handlers.set(
      route.file,
      (
        await import(
          new URL(`../../apps/farm/server/api/${route.file}`, import.meta.url)
            .href
        )
      ).default,
    )
  handlers.set(
    'job-history',
    (
      await import(
        new URL(
          '../../apps/farm/server/api/job-history/index.get.ts',
          import.meta.url,
        ).href
      )
    ).default,
  )
  const origin = backend.auth.origin
  const server: Server = createServer((req: IncomingMessage, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const url = new URL(req.url ?? '/', origin)
      const method = req.method ?? 'GET'
      let handler: Handler | undefined
      const params: Record<string, string> = {}
      if (url.pathname === '/api/job-history' && method === 'GET')
        handler = handlers.get('job-history')
      else
        for (const route of routeFiles) {
          const match =
            route.method === method ? route.pattern.exec(url.pathname) : null
          if (!match) continue
          route.names.forEach((name, index) => {
            params[name] = decodeURIComponent(match[index + 1] ?? '')
          })
          handler = handlers.get(route.file)
          break
        }
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers))
        if (typeof value === 'string') headers.set(key, value)
      const event = {
        req: new Request(url.href, {
          method,
          headers,
          ...(method === 'GET' ? {} : { body: Buffer.concat(chunks) }),
        }),
        res: { headers: new Headers(), status: 200 },
        context: {
          params,
          passwordReset: new PasswordResetRuntime(
            backend.auth,
            backend.resetLinks,
          ),
        },
      }
      res.setHeader('content-type', 'application/json')
      try {
        if (!handler)
          throw Object.assign(new Error('Recurso não encontrado.'), {
            status: 404,
          })
        const body = await handler(event)
        res.statusCode = 200
        res.end(JSON.stringify(body ?? null))
      } catch (error) {
        const status =
          error && typeof error === 'object' && 'status' in error
            ? Number((error as { status: unknown }).status)
            : 500
        res.statusCode = status
        res.end(
          JSON.stringify({
            statusCode: status,
            message: error instanceof Error ? error.message : 'Erro interno.',
          }),
        )
      }
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  const base = `http://127.0.0.1:${address.port}`
  const cookieConfig = backend.auth.cookie
  async function cookie(session: string): Promise<string> {
    const event = { req: new Request(origin), res: { headers: new Headers() } }
    const sealed = await useSession(event, cookieConfig)
    await sealed.update({ sessionRecordId: session })
    const value = event.res.headers.getSetCookie().at(-1)?.split(';')[0]
    assert.ok(value)
    return value
  }
  return {
    async request(session, method, path, body) {
      const response = await fetch(base + path, {
        method,
        headers: {
          cookie: await cookie(session),
          ...(method === 'POST'
            ? { origin, 'content-type': 'application/json' }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, text: await response.text() }
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      hooks.deregister()
      Reflect.deleteProperty(globalThis, backendToken)
    },
  }
}

export const testCookieConfig = (secret: string) =>
  ({
    name: SESSION_COOKIE_NAME,
    password: secret,
    maxAge: 3600,
    cookie: { ...SESSION_COOKIE_ATTRIBUTES },
  }) satisfies AuthRuntime['cookie']

const idsOf = (farm: FarmIds) => [
  farm.farmId,
  farm.agentId,
  farm.assignmentId,
  farm.printerKey,
  farm.inviteId,
  farm.memberId,
]

/**
 * Account 0 and account 1 each call the other's farm and a farm that exists
 * nowhere. Every route must answer both identically, expose nothing of the
 * other farm and leave every row untouched; the own farm must still work, so a
 * denial cannot come from a broken fixture.
 */
export async function assertCrossFarmDenied(
  scenario: Scenario,
  server: CrossFarmServer,
): Promise<{ checks: string[] }> {
  const checks: string[] = []
  for (const caller of [0, 1] as const) {
    const victim = scenario.farms[1 - caller]!
    const own = scenario.farms[caller]!
    const session = scenario.sessions[caller]
    const before = await scenario.snapshot()
    const ownCases = routeCases(own)
    const foreignCases = routeCases(victim)
    const unknownCases = routeCases(scenario.unknown)
    for (const [index, foreignCase] of foreignCases.entries()) {
      const label = `account ${caller} → ${foreignCase.name}`
      const unknownCase = unknownCases[index]!
      const foreign = await server.request(
        session,
        foreignCase.method,
        foreignCase.path,
        foreignCase.body,
      )
      const unknown = await server.request(
        session,
        unknownCase.method,
        unknownCase.path,
        unknownCase.body,
      )
      assert.equal(foreign.status, foreignCase.denied, `${label}: status`)
      assert.equal(unknown.status, foreignCase.denied, `${label}: unknown`)
      assert.equal(foreign.text, unknown.text, `${label}: same body as unknown`)
      for (const id of idsOf(victim))
        assert.ok(!foreign.text.includes(id), `${label}: leaks ${id}`)
      const ownCase = ownCases[index]!
      if (ownCase.marker) {
        const mine = await server.request(
          session,
          ownCase.method,
          ownCase.path,
          ownCase.body,
        )
        assert.equal(mine.status, 200, `${label}: own farm works`)
        assert.ok(mine.text.includes(ownCase.marker(own)), `${label}: marker`)
        for (const id of idsOf(victim))
          assert.ok(!mine.text.includes(id), `${label}: own farm leaks ${id}`)
      }
      checks.push(`${label}: ${foreignCase.denied}, identical to unknown farm`)
    }
    assert.deepEqual(
      await scenario.snapshot(),
      before,
      `account ${caller}: denied calls changed rows`,
    )
  }
  return { checks }
}
