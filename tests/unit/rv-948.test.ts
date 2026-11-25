/**
 * #948: two copies of one file, and a farm upload that fails while another one
 * records the same bytes, never leave a record without its file. No printer is
 * involved and no command is sent.
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

import { IntegrationLibraryService } from '../../apps/farm/server/services/integration-library.ts'
import { PostgresIntegrationLibrary } from '../../apps/farm/server/storage/integration-library-postgres.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'
import { createBlobStore } from '../../apps/farm/server/utils/library/blob-store.ts'
import { connectorLibraryRelay } from '../../apps/farm/server/utils/library/connector-relay.ts'
import { libraryRoutes } from '../../apps/farm/server/utils/library/routes.ts'
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

const directory = await mkdtemp(join(tmpdir(), 'rv-948-'))
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
let afterPut: () => Promise<void> = async () => {}

beforeEach(() => {
  disks.clear()
  afterPut = async () => {}
  vi.spyOn(connectorLibraryRelay, 'put').mockImplementation(async (input) => {
    const parts: Buffer[] = []
    for await (const part of input.body) parts.push(Buffer.from(part))
    const bytes = Buffer.concat(parts)
    const created = !disk(input.agentId).has(sha(bytes))
    disk(input.agentId).set(sha(bytes), bytes)
    await afterPut()
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

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open, opened }
}

describe.skipIf(!postgresReady)('with PostgreSQL', () => {
  const database = postgresReady
    ? disposablePostgres({
        ...vitestPostgresOptions('openfarm-rv-948'),
        isolated: true,
      })
    : undefined
  let root: Sql
  /** A login with only the integration role. */
  let api: Sql
  /** A login with only the farm library role. */
  let farmRole: Sql

  beforeAll(async () => {
    root = await database!.start()
    const login = async (name: string, role: string) => {
      await root.unsafe(
        `CREATE ROLE ${name} LOGIN PASSWORD 'rv-948-fixture' IN ROLE ${role}`,
      )
      const url = new URL(database!.connectionString)
      url.username = name
      url.password = 'rv-948-fixture'
      return postgres(url.toString(), { max: 3, onnotice: () => {} })
    }
    api = await login('rv_948_api', 'farm_integration_jobs')
    farmRole = await login('rv_948_farm', 'farm_library')
  }, 60_000)
  afterAll(async () => {
    await api?.end({ timeout: 3 })
    await farmRole?.end({ timeout: 3 })
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
      VALUES (${randomUUID()}, ${farm}, ${first}, 'rv-948', 1, ${owner})`
    const app = randomUUID()
    await root`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by)
      VALUES (${app}, ${farm}, 'rv 948', false, 1, ${owner})`
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
    return { owner, farm, first, second, principal }
  }

  it('#948: a second copy of a file survives the first one being refused', async () => {
    const f = await farmFixture()
    const bytes = gcode(`two copies ${f.farm}`)
    const library = new PostgresIntegrationLibrary(api)
    const source = await new IntegrationLibraryService(library).upload(
      f.principal,
      { farmId: f.farm, name: 'part.gcode', bytes },
      1 << 20,
    )
    if (!source.ok) throw new Error(source.problem)
    const place = () => library.placeOn(source.value.version.id, f.second)
    await root`INSERT INTO farm.library_connector_storage (farm_id, agent_id, quota_bytes, used_bytes, reported_at)
      VALUES (${f.farm}, ${f.second}, ${bytes.length}, 0, ${Date.now()})`

    const secondWritten = gate()
    const firstDone = gate()
    let second: Promise<unknown> | undefined
    afterPut = async () => {
      // The second copy finds the file already there.
      afterPut = async () => {
        afterPut = async () => {}
        secondWritten.open()
        await firstDone.opened
      }
      // Room for the second copy; the first one's quota is used up.
      await root`UPDATE farm.library_connector_storage SET quota_bytes = ${bytes.length * 10} WHERE farm_id = ${f.farm}`
      await root`INSERT INTO farm.library_blobs (farm_id, sha256, size_bytes, storage_location, agent_id, created_at)
        VALUES (${f.farm}, ${'0'.repeat(64)}, 1, 'connector', ${f.second}, ${Date.now()})`
      second = place()
      await secondWritten.opened
    }
    expect(await place()).toBe('quota-exceeded')
    expect(disk(f.second).has(sha(bytes))).toBe(false)
    firstDone.open()

    expect(await second).toBe('ready')
    expect(
      await root`SELECT 1 FROM farm.library_blobs
        WHERE farm_id = ${f.farm} AND sha256 = ${sha(bytes)} AND agent_id = ${f.second} AND purged_at IS NULL`,
    ).toHaveLength(1)
    expect(disk(f.second).get(sha(bytes))).toEqual(bytes)
  })

  it.each(['connector', 'server'] as const)(
    '#948: a failed %s-mode farm upload removes only bytes no record points at',
    async (mode) => {
      const f = await farmFixture()
      const now = Date.now()
      state.session = randomUUID()
      await root`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at)
        VALUES (${state.session}, ${f.owner}, 0, ${now}, ${now}, ${now + 3_600_000})`
      await root`INSERT INTO farm.library_settings (farm_id, storage_mode, quota_bytes, retention_days, updated_by, updated_at)
        VALUES (${f.farm}, ${mode}, 1000000, 30, ${f.owner}, ${now})`
      const blobs = await createBlobStore(directory)
      const auth = {
        origin: 'https://farm.test',
        idleTimeoutMs: 3_600_000,
        credentials: { consumeLimit: async () => true },
      } as unknown as AuthRuntime
      const upload = async (
        bytes: Buffer,
        store = new PostgresLibrary(farmRole),
        itemId?: string,
      ) => {
        const url = new URL('https://farm.test/api/library?name=part.gcode')
        if (mode === 'connector') url.searchParams.set('agentId', f.first)
        if (itemId) url.searchParams.set('itemId', itemId)
        const req = new Request(url, {
          method: 'POST',
          headers: {
            origin: auth.origin,
            'content-type': 'application/octet-stream',
          },
          body: bytes,
          duplex: 'half',
        } as RequestInit)
        const res = { headers: new Headers(), status: 200 }
        try {
          await libraryRoutes(
            { req, res } as never,
            'upload',
            { farmId: f.farm },
            {
              auth,
              runtime: { store, blobs, relay: connectorLibraryRelay },
            },
          )
        } catch (error) {
          return (error as { status: number }).status
        }
        return res.status
      }
      const has = async (bytes: Buffer) =>
        mode === 'server'
          ? blobs.has(sha(bytes))
          : disk(f.first).has(sha(bytes))

      // Alone, a refused upload removes what it wrote.
      const alone = gcode(`alone ${mode} ${f.farm}`)
      expect(await upload(alone, undefined, randomUUID())).toBe(404)
      expect(await has(alone)).toBe(false)

      // Another upload records the same bytes before this one is refused.
      const shared = gcode(`shared ${mode} ${f.farm}`)
      let other = 0
      class Overtaken extends PostgresLibrary {
        override async addVersion(
          ...args: Parameters<PostgresLibrary['addVersion']>
        ) {
          other = await upload(shared)
          return super.addVersion(...args)
        }
      }
      expect(await upload(shared, new Overtaken(farmRole), randomUUID())).toBe(
        404,
      )
      expect(other).toBe(201)
      expect(await has(shared)).toBe(true)
    },
  )
})
