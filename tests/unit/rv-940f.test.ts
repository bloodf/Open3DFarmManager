/**
 * #941: the #940 follow-ups, one test per item. No printer is involved and no
 * command is sent.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres, { type Sql } from 'postgres'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const state = vi.hoisted(() => ({ directory: '', session: '' }))

vi.mock('nuxt/server', () => ({
  useRuntimeConfig: () => ({
    library: {
      enabled: true,
      // Never dialled: storing bytes only touches the blob directory.
      databaseUrl: 'postgres://fixture:fixture@127.0.0.1:1/fixture',
      directory: state.directory,
    },
  }),
  createError: (input: { status: number; message: string }) =>
    Object.assign(new Error(input.message), input),
}))
// The farm upload route behind a session that is already authenticated.
vi.mock('../../apps/farm/server/services/authenticated-session.ts', () => ({
  authResponse: () => {},
  authenticatedSession: async () => {},
  sealedSessionRecordId: async () => state.session,
}))

import { seedSandbox } from '../../scripts/sandbox-seed.ts'
import {
  loadMigrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'
import { IntegrationLibraryService } from '../../apps/farm/server/services/integration-library.ts'
import { PostgresIntegrationLibrary } from '../../apps/farm/server/storage/integration-library-postgres.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'
import { connectorLibraryRelay } from '../../apps/farm/server/utils/library/connector-relay.ts'
import { libraryRoutes } from '../../apps/farm/server/utils/library/routes.ts'
import { libraryRuntime } from '../../apps/farm/server/utils/library/runtime.ts'
import { PostgresLibrary } from '../../apps/farm/server/utils/library/store.ts'
import {
  disposablePostgres,
  findPostgresBin,
} from '../helpers/disposable-postgres.ts'
import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'

let postgresReady = false
try {
  if (process.env.OPENFARM_PG !== 'docker') findPostgresBin()
  postgresReady = true
} catch {
  // The unit suite also runs on hosts with no PostgreSQL executable.
}

const sha = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex')
const gcode = (label: string) =>
  Buffer.from(`; ${label}\nG28\n${'G1 X10 Y10\n'.repeat(20)}`)

const directory = await mkdtemp(join(tmpdir(), 'rv-940f-'))
state.directory = directory
afterAll(() => rm(directory, { recursive: true, force: true }))

/** Each Connector's library directory, behind the relay the server uses. */
const disks = new Map<string, Map<string, Buffer>>()
const disk = (agentId: string) => {
  let files = disks.get(agentId)
  if (!files) disks.set(agentId, (files = new Map()))
  return files
}
/** Runs after a relayed file is on the Connector, before the caller resumes. */
let afterPut: (agentId: string) => Promise<void> = async () => {}

beforeEach(() => {
  disks.clear()
  afterPut = async () => {}
  vi.spyOn(connectorLibraryRelay, 'put').mockImplementation(async (input) => {
    const parts: Buffer[] = []
    for await (const part of input.body) parts.push(Buffer.from(part))
    const bytes = Buffer.concat(parts)
    const created = !disk(input.agentId).has(sha(bytes))
    disk(input.agentId).set(sha(bytes), bytes)
    await afterPut(input.agentId)
    return { sha256: sha(bytes), size: bytes.length, created }
  })
  vi.spyOn(connectorLibraryRelay, 'read').mockImplementation(async (input) => {
    const bytes = disk(input.agentId).get(input.sha256)
    if (!bytes) throw new Error('not found')
    return bytes.subarray(input.offset, input.offset + input.length)
  })
  vi.spyOn(connectorLibraryRelay, 'discard').mockImplementation(
    async (input) => void disk(input.agentId).delete(input.sha256),
  )
})
afterEach(() => vi.restoreAllMocks())

it.skipIf(!postgresReady)(
  '#941: the sandbox seed grants the library scopes farm-wide',
  async () => {
    const pg = disposablePostgres({
      ...vitestPostgresOptions('openfarm-rv-940f-sandbox'),
      isolated: true,
      through: false,
    })
    const sandbox = await mkdtemp(join(tmpdir(), 'rv-940f-sandbox-'))
    try {
      const sql = await pg.start()
      await runMigrations(sql, await loadMigrationCatalog(), { kind: 'up' })
      await seedSandbox(
        sql,
        new URL(`postgres://fixture:fixture@127.0.0.1:${pg.port}/fixture`),
        sandbox,
        {
          local: true,
          origin: 'https://127.0.0.1:3000',
          moonraker: 'http://127.0.0.1:7125',
        },
      )
      const grants = await sql<{ scopes: string[]; printer: string | null }[]>`
        SELECT g.scopes, g.printer_assignment_id AS printer
        FROM farm.integration_app_grants g
        JOIN farm.integration_apps a ON a.id = g.app_id
        WHERE a.name = 'Sandbox'`
      expect(grants).toHaveLength(1)
      expect(grants[0]!.printer).toBeNull()
      expect(grants[0]!.scopes).toEqual(
        expect.arrayContaining(['library:read', 'library:write']),
      )
    } finally {
      await pg.stop()
      await rm(sandbox, { recursive: true, force: true })
    }
  },
  120_000,
)

describe.skipIf(!postgresReady)('with PostgreSQL', () => {
  const database = postgresReady
    ? disposablePostgres({
        ...vitestPostgresOptions('openfarm-rv-940f'),
        isolated: true,
      })
    : undefined
  let root: Sql
  /** A login with only the integration role and no lock_timeout of its own. */
  let api: Sql

  beforeAll(async () => {
    root = await database!.start()
    await root.unsafe(
      `CREATE ROLE rv_940f_api LOGIN PASSWORD 'rv-940f-fixture' IN ROLE farm_integration_jobs`,
    )
    const url = new URL(database!.connectionString)
    url.username = 'rv_940f_api'
    url.password = 'rv-940f-fixture'
    api = postgres(url.toString(), { max: 3, onnotice: () => {} })
  }, 60_000)
  afterAll(async () => {
    await api?.end({ timeout: 3 })
    await database?.stop()
  })

  async function farmFixture() {
    const owner = `owner_${randomUUID().replaceAll('-', '')}`
    const farm = randomUUID()
    const [first, second] = [randomUUID(), randomUUID()]
    await root`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
    await root`INSERT INTO farm.farms (id, sandbox) VALUES (${farm}, false)`
    await root`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}, ${owner}, 'owner')`
    for (const agent of [first, second]) {
      await root`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint)
        VALUES (${agent}, ${farm}, ${'k'.repeat(59)}, ${agent.padEnd(50, 'f')})`
      await root`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}`
    }
    await root`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by)
      VALUES (${randomUUID()}, ${farm}, ${first}, 'rv-940f', 1, ${owner})`
    const app = randomUUID()
    await root`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by)
      VALUES (${app}, ${farm}, 'rv 940f', false, 1, ${owner})`
    const principal: IntegrationPrincipal = {
      appId: app,
      scopes: ['library:read', 'library:write'],
      grants: [
        {
          id: randomUUID(),
          appId: app,
          farmId: farm,
          printerAssignmentId: null,
          scopes: ['library:read', 'library:write'],
          requiresApproval: false,
          createdAt: 1,
          disabledAt: null,
          disabledReason: null,
        },
      ],
    }
    const upload = (
      library: IntegrationLibraryService,
      bytes: Buffer,
      name = 'part.gcode',
    ) => library.upload(principal, { farmId: farm, name, bytes }, 1 << 20)
    return { owner, farm, first, second, principal, upload }
  }

  it('#941: a server-mode upload writes once and answers library-busy, not a long wait, while the farm is locked', async () => {
    const f = await farmFixture()
    const library = new IntegrationLibraryService(
      new PostgresIntegrationLibrary(api),
    )
    await library.setSettings(f.principal, f.farm, 'server')
    const { blobs } = await libraryRuntime()
    const put = vi.spyOn(blobs!, 'put')
    const bytes = gcode(`busy ${f.farm}`)

    // Another upload of this farm holds its lock.
    let locked!: () => void
    let release!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const released = new Promise<void>((resolve) => (release = resolve))
    const holder = root.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'library:' + f.farm}, 0))`
      locked()
      await released
    })
    await isLocked
    // Without a lock_timeout the upload would only finish after this release.
    const fallback = setTimeout(release, 5000)
    try {
      expect(await f.upload(library, bytes)).toEqual({
        ok: false,
        problem: 'service-unavailable',
        reason: 'library-busy',
      })
    } finally {
      clearTimeout(fallback)
      release()
      await holder
    }

    put.mockClear()
    expect(await f.upload(library, bytes)).toMatchObject({ ok: true })
    // The file is not written a second time while the locks are held.
    expect(put).toHaveBeenCalledTimes(1)
    ;(await blobs!.read(sha(bytes))).stream.destroy()
  })

  it.each(['farm route', 'integration'] as const)(
    '#941: a refused copy never leaves a %s upload of the same file without it',
    async (path) => {
      const f = await farmFixture()
      const bytes = gcode(`copy race ${f.farm}`)
      const source = await f.upload(
        new IntegrationLibraryService(new PostgresIntegrationLibrary(api)),
        bytes,
      )
      if (!source.ok) throw new Error(source.problem)

      // The upload has written its bytes but not recorded them yet.
      let written!: () => void
      let copied!: () => void
      const isWritten = new Promise<void>((resolve) => (written = resolve))
      const isCopied = new Promise<void>((resolve) => (copied = resolve))
      const pause = async () => {
        written()
        await isCopied
      }

      let upload: () => Promise<number>
      if (path === 'integration') {
        class Paused extends PostgresIntegrationLibrary {
          override async agentFor() {
            return f.second
          }
          // The earlier item is not on the page that dedupes uploads.
          override async list() {
            return []
          }
          override async retain(
            ...args: Parameters<PostgresIntegrationLibrary['retain']>
          ) {
            await super.retain(...args)
            await pause()
          }
        }
        const library = new IntegrationLibraryService(new Paused(api))
        upload = async () =>
          (await f.upload(library, bytes)).ok ? 201 : (503 as number)
      } else {
        const now = Date.now()
        state.session = randomUUID()
        await root`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at)
          VALUES (${state.session}, ${f.owner}, 0, ${now}, ${now}, ${now + 3_600_000})`
        await root`INSERT INTO farm.library_settings (farm_id, storage_mode, quota_bytes, retention_days, updated_by, updated_at)
          VALUES (${f.farm}, 'connector', 1000000, 30, ${f.owner}, ${now})`
        const auth = {
          origin: 'https://farm.test',
          idleTimeoutMs: 3_600_000,
          credentials: { consumeLimit: async () => true },
        } as unknown as AuthRuntime
        class Paused extends PostgresLibrary {
          override async addVersion(
            ...args: Parameters<PostgresLibrary['addVersion']>
          ) {
            await pause()
            return super.addVersion(...args)
          }
        }
        upload = async () => {
          const req = new Request(
            `https://farm.test/api/library?name=part.gcode&agentId=${f.second}`,
            {
              method: 'POST',
              headers: {
                origin: auth.origin,
                'content-type': 'application/octet-stream',
              },
              body: bytes,
              duplex: 'half',
            } as RequestInit,
          )
          const res = { headers: new Headers(), status: 200 }
          try {
            await libraryRoutes(
              { req, res } as never,
              'upload',
              { farmId: f.farm },
              {
                auth,
                runtime: {
                  store: new Paused(root),
                  relay: connectorLibraryRelay,
                },
              },
            )
          } catch (error) {
            return (error as { status: number }).status
          }
          return res.status
        }
      }

      // Room for the copy when it starts, none once it has arrived.
      await root`INSERT INTO farm.library_connector_storage (farm_id, agent_id, quota_bytes, used_bytes, reported_at)
        VALUES (${f.farm}, ${f.second}, ${bytes.length}, 0, ${Date.now()})`
      let uploading: Promise<number> | undefined
      afterPut = async () => {
        afterPut = async () => {}
        await root`INSERT INTO farm.library_blobs (farm_id, sha256, size_bytes, storage_location, agent_id, created_at)
          VALUES (${f.farm}, ${'0'.repeat(64)}, 1, 'connector', ${f.second}, ${Date.now()})`
        uploading = upload()
        await isWritten
      }
      const placing = new PostgresIntegrationLibrary(api)
      expect(await placing.placeOn(source.value.version.id, f.second)).toBe(
        'quota-exceeded',
      )
      expect(disk(f.second).has(sha(bytes))).toBe(false)
      copied()
      const status = await uploading!

      const recorded = () => root`
        SELECT 1 FROM farm.library_blobs
        WHERE farm_id = ${f.farm} AND sha256 = ${sha(bytes)} AND agent_id = ${f.second} AND purged_at IS NULL`
      if (path === 'integration') {
        // The bytes are at hand, so they are written again.
        expect(status).toBe(201)
      } else {
        // The route streamed its bytes away: nothing is recorded, retry.
        expect(status).toBe(503)
        expect(await recorded()).toHaveLength(0)
        expect(await upload()).toBe(201)
      }
      expect(await recorded()).toHaveLength(1)
      expect(disk(f.second).has(sha(bytes))).toBe(true)
    },
  )
})
