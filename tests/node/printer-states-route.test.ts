import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { once } from 'node:events'
import { registerHooks } from 'node:module'
import { test, after } from 'node:test'
import type { Sql } from 'postgres'
import { useSession } from '../../apps/farm/node_modules/nuxt/dist/server/index.js'
import {
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
} from '../../apps/farm/server/utils/auth/boundary.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import type { PrinterStateReader } from '../../apps/farm/server/utils/printer-states/runtime.ts'
import type { PrinterStateRow } from '../../apps/farm/server/services/printer-states-core.ts'

const origin = 'https://farm.example.invalid'
const farmId = '11111111-1111-4111-8111-111111111111'
const otherFarmId = '22222222-2222-4222-8222-222222222222'
const agentId = '33333333-3333-4333-8333-333333333333'
const assignmentId = '44444444-4444-4444-8444-444444444444'
const sessionRecordId = 'printer_states_session'
const cookieConfig = {
  name: SESSION_COOKIE_NAME,
  password: 'independent-synthetic-printer-states-secret-123456789',
  maxAge: 3600,
  cookie: { ...SESSION_COOKIE_ATTRIBUTES },
} satisfies AuthRuntime['cookie']

const auth: AuthRuntime = {
  origin,
  cookie: cookieConfig,
  idleTimeoutMs: 60000,
  lifetimeMs: 3600000,
  sessions: {
    async authorizeAndTouch() {
      return { ok: true as const, accountId: 'account', touchAt: 1 }
    },
    async revokeSession() {},
    async revokeAccountSessions() {},
  },
  credentials: {
    async consumeLimit() {
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

/**
 * The route resolves its reader through the runtime. The runtime is replaced at
 * its public boundary so the route itself stays under test.
 */
const runtimeToken = Symbol.for('printer-states-route-test-runtime')
const configToken = Symbol.for('printer-states-route-test-config')
const authToken = Symbol.for('printer-states-route-test-auth')
type RuntimeState = { enabled: boolean; reader: PrinterStateReader | undefined }
const runtimeState: RuntimeState = { enabled: true, reader: undefined }
Object.defineProperty(globalThis, runtimeToken, {
  configurable: true,
  writable: true,
  value: () => runtimeState,
})
Object.defineProperty(globalThis, configToken, {
  configurable: true,
  writable: true,
  value: () => ({ printerStates: { enabled: runtimeState.enabled } }),
})
Object.defineProperty(globalThis, authToken, {
  configurable: true,
  writable: true,
  value: () => auth,
})
const moduleUrl = (source: string) =>
  `data:text/javascript,${encodeURIComponent(source)}`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === 'nuxt/server' &&
      context.parentURL?.includes('/server/')
    ) {
      return {
        url: moduleUrl(
          `export * from ${JSON.stringify(new URL('../../apps/farm/node_modules/nuxt/dist/server/index.js', import.meta.url).href)}
           export const useRuntimeConfig = () => globalThis[Symbol.for('printer-states-route-test-config')]()`,
        ),
        shortCircuit: true,
      }
    }
    if (
      specifier.endsWith('/utils/printer-states/runtime.ts') &&
      context.parentURL?.includes('/server/')
    ) {
      return {
        url: moduleUrl(
          `export const printerStatesRuntime = () => {
             const state = globalThis[Symbol.for('printer-states-route-test-runtime')]()
             if (!state.enabled) {
               throw Object.assign(new Error('Estados das impressoras indisponível.'), { status: 404 })
             }
             return state.reader
           }
           export const closePrinterStatesRuntime = async () => {}`,
        ),
        shortCircuit: true,
      }
    }
    if (
      specifier.endsWith('/utils/auth/runtime.ts') &&
      context.parentURL?.includes('/server/')
    ) {
      return {
        url: moduleUrl(
          `export const authRuntime = () => globalThis[Symbol.for('printer-states-route-test-auth')]()`,
        ),
        shortCircuit: true,
      }
    }
    return next(specifier, context)
  },
})
const route = (
  await import('../../apps/farm/server/api/farms/[farmId]/printer-states.get.ts')
).default

after(() => {
  hooks.deregister()
  Reflect.deleteProperty(globalThis, runtimeToken)
  Reflect.deleteProperty(globalThis, configToken)
  Reflect.deleteProperty(globalThis, authToken)
})

async function sealedCookie(): Promise<string> {
  const event = {
    req: new Request(origin),
    res: { headers: new Headers() },
  }
  const session = await useSession(event, cookieConfig)
  await session.update({ sessionRecordId })
  const sealed = event.res.headers.getSetCookie().at(-1)?.split(';')[0]
  assert.ok(sealed)
  return sealed
}

const storedState: PrinterStateRow = {
  assignmentId,
  printerKey: 'printer-key-1',
  state: 'printing',
  progress: 0.42,
  toolTemperatureCelsius: 210.5,
  bedTemperatureCelsius: 59.5,
  observedAt: 1_700_000_000_000,
}

/** A live session row as the storage reader expects to find it. */
const sessionRow = {
  id: sessionRecordId,
  accountId: 'account',
  accountVersion: 1,
  createdAt: 1_699_999_000_000,
  lastSeenAt: 1_699_999_980_000,
  absoluteExpiresAt: 1_700_000_900_000,
  revokedAt: null,
}

/** The reader answers exactly like the inventory reader for the same farm. */
function reader(memberships: Record<string, 'member' | 'none'>) {
  const calls: string[] = []
  const reader: PrinterStateReader = {
    async list(input) {
      calls.push(input.farmId)
      if (memberships[input.farmId] !== 'member')
        return { ok: false, reason: 'forbidden' }
      return { ok: true, states: [storedState] }
    },
  }
  return { reader, calls }
}

type ServerFixture = {
  url: string
  close: () => Promise<void>
}

/**
 * Serves the route over HTTP on an ephemeral loopback port. The handler is
 * wrapped so a thrown error becomes the status the browser would observe.
 */
async function serve(handler: unknown): Promise<ServerFixture> {
  const routeHandler = handler as (event: unknown) => Promise<unknown>
  const server: Server = createServer((req: IncomingMessage, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin)
      const segments = url.pathname.split('/').filter(Boolean)
      const params =
        segments[0] === 'api' &&
        segments[1] === 'farms' &&
        segments[3] === 'printer-states'
          ? { farmId: decodeURIComponent(segments[2] ?? '') }
          : {}
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value)
        else if (Array.isArray(value)) headers.set(key, value.join(', '))
      }
      const event = {
        req: new Request(url.href, {
          method: req.method ?? 'GET',
          headers,
        }),
        res: { headers: new Headers(), status: 200 },
        context: { params },
      }
      try {
        const body = await routeHandler(event)
        event.res.status = 200
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body ?? null))
      } catch (error) {
        const status =
          error && typeof error === 'object' && 'status' in error
            ? Number((error as { status: unknown }).status)
            : 500
        const message =
          error && typeof error === 'object' && 'message' in error
            ? String((error as { message: unknown }).message)
            : 'Erro interno.'
        event.res.status = status
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ statusCode: status, message }))
      }
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}

test('a farm member reads the last known states of the active assignments', async () => {
  const { reader: stub, calls } = reader({ [farmId]: 'member' })
  runtimeState.enabled = true
  runtimeState.reader = stub
  const fixture = await serve(route)
  try {
    const response = await fetch(
      `${fixture.url}/api/farms/${farmId}/printer-states`,
      { headers: { cookie: await sealedCookie() } },
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { states: unknown[] }
    assert.equal(body.states.length, 1)
    assert.deepEqual(body.states[0], {
      assignmentId,
      printerKey: 'printer-key-1',
      state: 'printing',
      progress: 0.42,
      temperatures: { toolCelsius: 210.5, bedCelsius: 59.5 },
      observedAt: 1_700_000_000_000,
    })
    assert.deepEqual(calls, [farmId])
  } finally {
    await fixture.close()
  }
})

test('a viewer reads the same states as any other farm role', async () => {
  const { reader: stub } = reader({ [farmId]: 'member' })
  runtimeState.enabled = true
  runtimeState.reader = stub
  const fixture = await serve(route)
  try {
    const response = await fetch(
      `${fixture.url}/api/farms/${farmId}/printer-states`,
      { headers: { cookie: await sealedCookie() } },
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { states: unknown[] }
    assert.equal(body.states.length, 1)
  } finally {
    await fixture.close()
  }
})

test('a non-member gets 404 and never learns whether the farm exists', async () => {
  const { reader: stub } = reader({ [otherFarmId]: 'member' })
  runtimeState.enabled = true
  runtimeState.reader = stub
  const fixture = await serve(route)
  try {
    const response = await fetch(
      `${fixture.url}/api/farms/${farmId}/printer-states`,
      { headers: { cookie: await sealedCookie() } },
    )
    assert.equal(response.status, 404)
    const body = (await response.json()) as { message: string }
    assert.match(body.message, /Farm indisponível/)
    // The denied farm and an unknown farm look identical to the caller.
    const unknown = await fetch(
      `${fixture.url}/api/farms/99999999-9999-4999-8999-999999999999/printer-states`,
      { headers: { cookie: await sealedCookie() } },
    )
    assert.equal(unknown.status, 404)
  } finally {
    await fixture.close()
  }
})

test('another farm of the same account is denied independently', async () => {
  const { reader: stub, calls } = reader({ [farmId]: 'member' })
  runtimeState.enabled = true
  runtimeState.reader = stub
  const fixture = await serve(route)
  try {
    const response = await fetch(
      `${fixture.url}/api/farms/${otherFarmId}/printer-states`,
      { headers: { cookie: await sealedCookie() } },
    )
    assert.equal(response.status, 404)
    assert.deepEqual(calls, [otherFarmId])
  } finally {
    await fixture.close()
  }
})

test('the route is disabled cleanly while the runtime is off', async () => {
  const { reader: stub, calls } = reader({ [farmId]: 'member' })
  runtimeState.enabled = false
  runtimeState.reader = stub
  const fixture = await serve(route)
  try {
    const response = await fetch(
      `${fixture.url}/api/farms/${farmId}/printer-states`,
      { headers: { cookie: await sealedCookie() } },
    )
    assert.equal(response.status, 404)
    assert.deepEqual(calls, [])
  } finally {
    await fixture.close()
  }
})

test('the response carries no Connector identifier beyond the printer key', async () => {
  const { reader: stub } = reader({ [farmId]: 'member' })
  runtimeState.enabled = true
  runtimeState.reader = stub
  const fixture = await serve(route)
  try {
    const response = await fetch(
      `${fixture.url}/api/farms/${farmId}/printer-states`,
      { headers: { cookie: await sealedCookie() } },
    )
    assert.equal(response.status, 200)
    const raw = await response.text()
    // The inventory route exposes agentId and connectorStatus; neither may leak.
    assert.doesNotMatch(raw, /agentId|connectorStatus|agent_id/)
    assert.doesNotMatch(raw, new RegExp(agentId))
    assert.doesNotMatch(raw, /connector/i)
  } finally {
    await fixture.close()
  }
})

test('an unauthenticated request is denied before the reader is reached', async () => {
  const { reader: stub, calls } = reader({ [farmId]: 'member' })
  runtimeState.enabled = true
  runtimeState.reader = stub
  const fixture = await serve(route)
  try {
    const response = await fetch(
      `${fixture.url}/api/farms/${farmId}/printer-states`,
    )
    assert.equal(response.status, 401)
    assert.deepEqual(calls, [])
  } finally {
    await fixture.close()
  }
})

test('an invalid farm id is rejected before the reader is reached', async () => {
  const { reader: stub, calls } = reader({ [farmId]: 'member' })
  runtimeState.enabled = true
  runtimeState.reader = stub
  const fixture = await serve(route)
  try {
    const response = await fetch(
      `${fixture.url}/api/farms/not-a-uuid/printer-states`,
      {
        headers: { cookie: await sealedCookie() },
      },
    )
    assert.equal(response.status, 400)
    assert.deepEqual(calls, [])
  } finally {
    await fixture.close()
  }
})

test('the storage reader denies a non-member with the inventory membership check', async () => {
  const { PostgresPrinterStateReader } =
    await import('../../apps/farm/server/storage/postgres-printer-state-reader.ts')
  const queries: string[] = []
  const transaction = (strings: TemplateStringsArray) => {
    const query = strings.join('?')
    queries.push(query)
    if (query.includes('FROM farm.memberships')) return []
    if (
      query.includes('FROM farm.account_sessions') &&
      query.includes('SELECT id, account_id')
    )
      return [sessionRow]
    if (query.includes('FROM farm.session_accounts'))
      return [{ id: 'account', sessionVersion: 1, disabled: false }]
    if (query.includes('FROM farm.printer_assignments')) return []
    return []
  }
  const sql = Object.assign(async (strings: TemplateStringsArray) => [], {
    begin: async (fn: (tx: unknown) => unknown) =>
      fn(
        Object.assign(
          async (strings: TemplateStringsArray) => transaction(strings),
          { json: (value: unknown) => value },
        ),
      ),
  }) as unknown as Sql
  const store = new PostgresPrinterStateReader(sql, () => 1_700_000_000_000)
  const result = await store.list({
    farmId,
    sessionRecordId,
    policy: { idleTimeoutMs: 60000 },
  })
  assert.deepEqual(result, { ok: false, reason: 'forbidden' })
  // The same membership predicate the printer inventory uses.
  const membership = queries.find((query) =>
    query.includes('FROM farm.memberships'),
  )
  assert.ok(membership)
  assert.match(
    membership,
    /FROM farm\.memberships WHERE farm_id = \?::uuid AND account_id = \? FOR SHARE/,
  )
  assert.match(membership, /SELECT revoked_at FROM farm\.memberships/)
  // No state row is read for a farm the account cannot see.
  assert.equal(
    queries.some((query) => query.includes('FROM farm.printer_assignments')),
    false,
  )
})

test('the storage reader returns only the active assignments of the farm', async () => {
  const { PostgresPrinterStateReader } =
    await import('../../apps/farm/server/storage/postgres-printer-state-reader.ts')
  const queries: string[] = []
  const transaction = (strings: TemplateStringsArray) => {
    const query = strings.join('?')
    queries.push(query)
    if (query.includes('FROM farm.memberships'))
      return [{ role: 'viewer', revoked_at: null }]
    if (
      query.includes('FROM farm.account_sessions') &&
      query.includes('SELECT id, account_id')
    )
      return [sessionRow]
    if (query.includes('FROM farm.session_accounts'))
      return [{ id: 'account', sessionVersion: 1, disabled: false }]
    if (query.includes('FROM farm.printer_assignments'))
      return [
        {
          assignmentId,
          printerKey: 'printer-key-1',
          state: {
            printerKey: 'printer-key-1',
            state: 'printing',
            progress: 0.42,
            toolTemperatureCelsius: 210.5,
            bedTemperatureCelsius: 59.5,
            observedAt: 1_700_000_000_000,
          },
        },
      ]
    return []
  }
  const sql = Object.assign(async (strings: TemplateStringsArray) => [], {
    begin: async (fn: (tx: unknown) => unknown) =>
      fn(
        Object.assign(
          async (strings: TemplateStringsArray) => transaction(strings),
          { json: (value: unknown) => value },
        ),
      ),
  }) as unknown as Sql
  const store = new PostgresPrinterStateReader(sql, () => 1_700_000_000_000)
  const result = await store.list({
    farmId,
    sessionRecordId,
    policy: { idleTimeoutMs: 60000 },
  })
  assert.deepEqual(result, {
    ok: true,
    states: [
      {
        assignmentId,
        printerKey: 'printer-key-1',
        state: 'printing',
        progress: 0.42,
        toolTemperatureCelsius: 210.5,
        bedTemperatureCelsius: 59.5,
        observedAt: 1_700_000_000_000,
      },
    ],
  })
  const assignments = queries.find((query) =>
    query.includes('FROM farm.printer_assignments'),
  )
  assert.ok(assignments)
  // Revoked assignments and other farms are excluded.
  assert.match(assignments, /a\.revoked_at IS NULL/)
  assert.match(assignments, /a\.farm_id = \?::uuid/)
  assert.match(
    assignments,
    /s\.farm_id = a\.farm_id AND s\.agent_id = a\.agent_id AND s\.printer_key = a\.printer_key/,
  )
})

test('the migration grants a read-only role and has a down file', async () => {
  const up = await readFile(
    new URL(
      '../../infra/db/migrations/0037_printer_state_reader.up.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const down = await readFile(
    new URL(
      '../../infra/db/migrations/0037_printer_state_reader.down.sql',
      import.meta.url,
    ),
    'utf8',
  )
  assert.match(up, /CREATE ROLE farm_printer_state_reader/)
  assert.match(
    up,
    /GRANT SELECT ON farm\.session_accounts, farm\.account_sessions, farm\.memberships, farm\.printer_assignments, farm\.printer_latest_state/,
  )
  assert.match(down, /DROP ROLE farm_printer_state_reader/)
})
