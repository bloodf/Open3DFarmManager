// The built-in Spoolman-compatible server, served the way Nitro serves
// apps/farm/server/routes/spoolman/[...path].ts: one h3 handler carrying the
// HTTP handler and the websocket hooks, behind a loopback server, on the real
// PostgreSQL storage in the harness's disposable container.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import wsAdapter from 'crossws/adapters/node'
import {
  createApp,
  createRouter,
  defineEventHandler,
  getRequestHeader,
  readRawBody,
  setResponseHeader,
  setResponseStatus,
  toNodeListener,
} from 'h3'
import postgres from 'postgres'
import { PostgresSpoolLibrary } from '../../../apps/farm/server/storage/postgres-spool-library.ts'
import { validateSpoolLibraryRole } from '../../../apps/farm/server/utils/spool-library/role-policy.ts'
import {
  classifyLegacyBody,
  describeLegacyBody,
} from '../../../apps/farm/server/utils/spool-library/legacy-api/body.ts'
import { createConfiguredExternalModule } from '../../../apps/farm/server/utils/spool-library/legacy-api/external-config.ts'
import {
  LEGACY_API_MODULES,
  handleLegacyRequest,
  legacyFailure,
} from '../../../apps/farm/server/utils/spool-library/legacy-handler.ts'
import { spoolFeedBus } from '../../../apps/farm/server/utils/spool-library/events.ts'
import { createSpoolFeedHooks } from '../../../apps/farm/server/utils/spool-library/ws-feed.ts'

const MAX_BODY_BYTES = 10 * 1024 * 1024

/**
 * @param {{ pgPort: number, externalUrl?: string }} options
 * `externalUrl` is the SpoolmanDB-style base URL of the loopback fixture server
 * (the module reads it from the configuration object given here, never from
 * the process environment).
 */
export async function startBuiltin({ pgPort, pgPassword, admin, externalUrl }) {
  const role = 'parity_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_spool_library, farm_spool_features`
  await admin.unsafe(`ALTER ROLE "${role}" PASSWORD '${pgPassword}'`)
  const runtime = postgres({
    host: '127.0.0.1',
    port: pgPort,
    database: 'fixture',
    username: role,
    password: pgPassword,
    ssl: false,
    max: 4,
    connect_timeout: 3,
    onnotice: () => {},
    connection: { search_path: 'pg_catalog' },
  })
  await validateSpoolLibraryRole(runtime)
  const clock = Date.UTC(2026, 10, 21, 8, 0, 0)
  const store = new PostgresSpoolLibrary(runtime, () => Date.now())
  const modules = LEGACY_API_MODULES.map((module) =>
    module.name === 'external-filament'
      ? createConfiguredExternalModule({
          SPOOLMAN_EXTERNAL_DB_URL: externalUrl,
        })
      : module,
  )
  if (!modules.some((m) => m.name === 'external-filament'))
    throw new Error('external module name changed: update the harness')

  async function newFarm(index) {
    const farm = randomUUID()
    const account = `acc-${farm}`
    const session = `session-${farm}`
    await admin`INSERT INTO farm.farms (id) VALUES (${farm}::uuid)`
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${account})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${session}, ${account}, 0, ${clock}, ${clock}, ${clock + 86_400_000})`
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}::uuid, ${account}, 'owner')`
    const issued = await store.issueLegacyCredential({
      sessionRecordId: session,
      policy: { idleTimeoutMs: 1e12 },
      farmId: farm,
      label: `parity-${index}`,
      access: 'write',
    })
    if (!issued.ok) throw new Error(`credential: ${issued.reason}`)
    return issued.value.token
  }

  const handler = defineEventHandler({
    websocket: createSpoolFeedHooks({ storage: async () => store }),
    async handler(event) {
      setResponseHeader(event, 'Cache-Control', 'no-store')
      setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
      const url = event.node.req.url ?? '/'
      const at = url.indexOf('?')
      let result
      try {
        const raw = ['POST', 'PATCH', 'PUT'].includes(event.method)
          ? await readRawBody(event, 'utf8')
          : undefined
        if (raw && Buffer.byteLength(raw) > MAX_BODY_BYTES) {
          setResponseStatus(event, 413)
          return { message: 'Request Entity Too Large' }
        }
        result = await handleLegacyRequest(
          store,
          {
            method: event.method,
            pathname: at === -1 ? url : url.slice(0, at),
            query: new URLSearchParams(at === -1 ? '' : url.slice(at + 1)),
            body: classifyLegacyBody(
              raw,
              getRequestHeader(event, 'content-type'),
            ),
            bodyDetails: describeLegacyBody(
              raw,
              getRequestHeader(event, 'content-type'),
            ),
            headers: {
              origin: getRequestHeader(event, 'origin') ?? null,
              host: getRequestHeader(event, 'host') ?? null,
              forwardedHost:
                getRequestHeader(event, 'x-forwarded-host') ?? null,
            },
          },
          modules,
        )
      } catch (error) {
        console.error('built-in handler failure', error)
        result = legacyFailure('storage-unavailable')
      }
      setResponseStatus(event, result.status)
      for (const [name, value] of Object.entries(result.headers ?? {}))
        setResponseHeader(event, name, value)
      return result.body
    },
  })
  const app = createApp()
  app.use(createRouter().use('/spoolman/**', handler))
  const server = createServer(toNodeListener(app))
  const { handleUpgrade } = wsAdapter(app.websocket)
  server.on('upgrade', handleUpgrade)
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()

  return {
    /** A fresh farm (empty inventory) reachable through its own credential. */
    async target(index) {
      const token = await newFarm(index)
      return {
        baseUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}`,
        prefix: `/spoolman/${token}`,
      }
    },
    async close() {
      spoolFeedBus.closeAll()
      await new Promise((done) => server.close(done))
      await runtime.end({ timeout: 3 })
    },
  }
}
