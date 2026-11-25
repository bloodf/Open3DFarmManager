/**
 * #916 and #917: integration G-code bytes. No printer is involved: the relay is
 * an in-memory stand-in for each Connector's disk, and envelopes are recorded
 * instead of delivered.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat, utimes } from 'node:fs/promises'
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

const state = vi.hoisted(() => ({ directory: '' }))

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

import { IntegrationApprovalService } from '../../apps/farm/server/services/integration-approval.ts'
import {
  IntegrationJobsService,
  type JobEnvelopes,
} from '../../apps/farm/server/services/integration-jobs.ts'
import {
  IntegrationLibraryService,
  MemoryLibraryStore,
  type NewLibraryVersion,
} from '../../apps/farm/server/services/integration-library.ts'
import { PostgresIntegrationApprovals } from '../../apps/farm/server/storage/integration-approval-postgres.ts'
import { PostgresIntegrationJobs } from '../../apps/farm/server/storage/integration-jobs-postgres.ts'
import { PostgresIntegrationLibrary } from '../../apps/farm/server/storage/integration-library-postgres.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'
import { createBlobStore } from '../../apps/farm/server/utils/library/blob-store.ts'
import { connectorLibraryRelay } from '../../apps/farm/server/utils/library/connector-relay.ts'
import { runLibraryRetention } from '../../apps/farm/server/utils/library/retention.ts'
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
const DAY_MS = 86_400_000

const directory = await mkdtemp(join(tmpdir(), 'rv-916-917-'))
state.directory = directory
afterAll(() => rm(directory, { recursive: true, force: true }))

/** Each Connector's library directory, behind the relay the server uses. */
const disks = new Map<string, Map<string, Buffer>>()
const offline = new Set<string>()
const disk = (agentId: string) => {
  if (offline.has(agentId)) throw new Error('Connector offline')
  let files = disks.get(agentId)
  if (!files) disks.set(agentId, (files = new Map()))
  return files
}
let puts: string[] = []

beforeEach(() => {
  disks.clear()
  offline.clear()
  puts = []
  vi.spyOn(connectorLibraryRelay, 'put').mockImplementation(async (input) => {
    const files = disk(input.agentId)
    const parts: Buffer[] = []
    for await (const part of input.body) parts.push(Buffer.from(part))
    const bytes = Buffer.concat(parts)
    puts.push(input.agentId)
    files.set(sha(bytes), bytes)
    return { sha256: sha(bytes), size: bytes.length, created: true }
  })
  vi.spyOn(connectorLibraryRelay, 'read').mockImplementation(async (input) => {
    const bytes = disk(input.agentId).get(input.sha256)
    if (!bytes) throw new Error('not found')
    return bytes.subarray(input.offset, input.offset + input.length)
  })
})
afterEach(() => vi.restoreAllMocks())

function principalFor(
  farmId: string,
  appId: string,
  printers: { id: string; grantId: string; requiresApproval: boolean }[],
): IntegrationPrincipal {
  const fields = { appId, createdAt: 1, disabledAt: null, farmId }
  return {
    appId,
    scopes: ['library:read', 'library:write', 'jobs:start', 'jobs:write'],
    grants: [
      {
        ...fields,
        id: randomUUID(),
        printerAssignmentId: null,
        scopes: ['library:read', 'library:write'],
        requiresApproval: false,
        disabledReason: null,
      },
      ...printers.map((printer) => ({
        ...fields,
        id: printer.grantId,
        printerAssignmentId: printer.id,
        scopes: ['jobs:start' as const, 'jobs:write' as const],
        requiresApproval: printer.requiresApproval,
        disabledReason: null,
      })),
    ],
  }
}

/** Records what would be sent; nothing is delivered anywhere. */
function recordedEnvelopes() {
  const issued: Parameters<JobEnvelopes['issue']>[0][] = []
  const envelopes: JobEnvelopes = {
    async issue(input) {
      issued.push(input)
      return {
        ok: true,
        created: false,
        record: { cmdId: randomUUID(), status: 'sent', updatedAt: 1 } as never,
      }
    },
    deliver: async () => 'sent' as never,
    get: async () => null,
  }
  return { issued, envelopes }
}

describe('without PostgreSQL', () => {
  // #917: the real upload service over the real `retain`, with only the rows
  // replaced. Passing a destination for resin alone, or returning early
  // without one, stores nothing and fails here.
  class RowlessLibrary extends PostgresIntegrationLibrary {
    private readonly memory = new MemoryLibraryStore()
    readonly agent = randomUUID()
    constructor() {
      super(undefined as never)
    }
    override getMode(farmId: string) {
      return this.memory.getMode(farmId)
    }
    override setMode(farmId: string, mode: 'server' | 'connector') {
      return this.memory.setMode(farmId, mode)
    }
    override async agentFor() {
      return this.agent
    }
    override async fits() {
      return true
    }
    override list(
      farmId: string,
      after: { createdAt: number; id: string } | null,
      limit: number,
    ) {
      return this.memory.list(farmId, after, limit)
    }
    override addVersion(version: NewLibraryVersion) {
      return this.memory.addVersion(version)
    }
    override async insertAudit() {}
  }

  it.each(['connector', 'server'] as const)(
    '#917: a %s-mode G-code upload stores its bytes (#857)',
    async (mode) => {
      const farm = randomUUID()
      const principal = principalFor(farm, randomUUID(), [])
      const store = new RowlessLibrary()
      await store.setMode(farm, mode)
      const bytes = gcode(`857 ${mode}`)
      const result = await new IntegrationLibraryService(store).upload(
        principal,
        { farmId: farm, name: 'part.gcode', bytes },
        1 << 20,
      )
      expect(result).toMatchObject({ ok: true })
      if (mode === 'connector')
        expect(disks.get(store.agent)?.get(sha(bytes))).toEqual(bytes)
      else
        expect(await (await createBlobStore(directory)).has(sha(bytes))).toBe(
          true,
        )
    },
  )

  it('#916: a repeated upload restarts the orphan grace of a stored file', async () => {
    const blobs = await createBlobStore(directory)
    const bytes = gcode('mtime')
    async function* body() {
      yield bytes
    }
    await blobs.put(body())
    const path = join(directory, sha(bytes))
    await utimes(path, new Date(0), new Date(0))
    expect(await blobs.put(body())).toMatchObject({ created: false })
    expect(Date.now() - (await stat(path)).mtimeMs).toBeLessThan(60_000)
  })
})

describe.skipIf(!postgresReady)('with PostgreSQL', () => {
  const database = postgresReady
    ? disposablePostgres({
        ...vitestPostgresOptions('openfarm-rv-916-917'),
        isolated: true,
      })
    : undefined
  let root: Sql
  /** A login with only the API runtime's roles, so missing grants fail. */
  let api: Sql

  beforeAll(async () => {
    root = await database!.start()
    await root.unsafe(
      `CREATE ROLE rv_916_api LOGIN PASSWORD 'rv-916-fixture' IN ROLE farm_integration_jobs, farm_integration_approvals, farm_integration_delivery`,
    )
    const url = new URL(database!.connectionString)
    url.username = 'rv_916_api'
    url.password = 'rv-916-fixture'
    api = postgres(url.toString(), { max: 3, onnotice: () => {} })
  }, 60_000)
  afterAll(async () => {
    await api?.end({ timeout: 3 })
    await database?.stop()
  })

  /** A farm with two Connectors; the first assignment id is on `first`. */
  async function farmFixture() {
    const owner = `owner_${randomUUID().replaceAll('-', '')}`
    const farm = randomUUID()
    const app = randomUUID()
    const [first, second] = [randomUUID(), randomUUID()]
    const [nearId, farId] = [randomUUID(), randomUUID()].sort() as [
      string,
      string,
    ]
    await root`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
    await root`INSERT INTO farm.farms (id, sandbox) VALUES (${farm}, false)`
    await root`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}, ${owner}, 'owner')`
    for (const agent of [first, second]) {
      await root`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint)
        VALUES (${agent}, ${farm}, ${'k'.repeat(59)}, ${agent.padEnd(50, 'f')})`
      await root`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}`
    }
    await root`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by)
      VALUES (${app}, ${farm}, 'rv 916', false, 1, ${owner})`
    const printers = [
      { id: nearId, agent: first, requiresApproval: true },
      { id: farId, agent: second, requiresApproval: false },
    ].map((printer) => ({ ...printer, grantId: randomUUID() }))
    for (const printer of printers) {
      await root`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by)
        VALUES (${printer.id}, ${farm}, ${printer.agent}, ${printer.id}, 1, ${owner})`
      await root`INSERT INTO farm.integration_app_grants
        (id, app_id, farm_id, printer_assignment_id, scopes, requires_approval, created_at, created_by)
        VALUES (${printer.grantId}, ${app}, ${farm}, ${printer.id}, ARRAY['jobs:start','jobs:write'], ${printer.requiresApproval}, 1, ${owner})`
    }
    const [near, far] = printers as [(typeof printers)[0], (typeof printers)[0]]
    const principal = principalFor(farm, app, printers)
    const library = new IntegrationLibraryService(
      new PostgresIntegrationLibrary(api),
    )
    const sent = recordedEnvelopes()
    const jobs = new IntegrationJobsService({
      store: new PostgresIntegrationJobs(api),
      library,
      envelopes: sent.envelopes,
    })
    const upload = (bytes: Buffer, name = 'part.gcode') =>
      library.upload(principal, { farmId: farm, name, bytes }, 1 << 20)
    const uploaded = async (bytes: Buffer, name?: string) => {
      const result = await upload(bytes, name)
      if (!result.ok) throw new Error(result.problem)
      return result.value.version.id
    }
    const submit = (printer: string, versionId: string) =>
      jobs.submit(principal, printer, `rv-916-${randomUUID()}`, {
        libraryVersionId: versionId,
      })
    const remove = (versionId: string) =>
      root`UPDATE farm.library_versions SET deleted_at = ${Date.now()} WHERE id = ${versionId}`
    const blobRows = (bytes: Buffer) =>
      root<{ agent: string | null; purged: boolean }[]>`
        SELECT agent_id::text AS agent, purged_at IS NOT NULL AS purged
        FROM farm.library_blobs WHERE farm_id = ${farm} AND sha256 = ${sha(bytes)}`
    const retention = async (later: number) =>
      runLibraryRetention(
        {
          sql: root,
          blobs: await createBlobStore(directory),
          connectors: {
            async purge(agentId, hashes) {
              for (const hash of hashes) disk(agentId).delete(hash)
              return [...hashes]
            },
            sweep: async () => [],
          },
          clock: () => Date.now() + later,
        },
        { batchSize: 100 },
      )
    return {
      owner,
      farm,
      first,
      second,
      near,
      far,
      principal,
      library,
      sent,
      upload,
      uploaded,
      submit,
      remove,
      blobRows,
      retention,
    }
  }

  it('#916: a replay on a second Connector gets the file there, and the copy survives retention', async () => {
    const f = await farmFixture()
    const bytes = gcode(`multi ${f.farm}`)
    const version = await f.uploaded(bytes)
    expect(puts).toEqual([f.first])

    expect(await f.submit(f.far.id, version)).toMatchObject({ ok: true })
    expect(disks.get(f.second)?.get(sha(bytes))).toEqual(bytes)
    expect(f.sent.issued.map((input) => input.agentId)).toEqual([f.second])

    // Past the orphan grace the copy stays while the version is live.
    await f.retention(2 * 3_600_000)
    expect(await f.blobRows(bytes)).toEqual(
      expect.arrayContaining([
        { agent: f.first, purged: false },
        { agent: f.second, purged: false },
      ]),
    )
    expect(await f.submit(f.far.id, version)).toMatchObject({ ok: true })
    expect(puts).toEqual([f.first, f.second])

    // Once the version is gone the copy is an ordinary orphan.
    await f.remove(version)
    await f.retention(2 * 3_600_000)
    expect(await f.blobRows(bytes)).toContainEqual({
      agent: f.second,
      purged: true,
    })

    // A copy that cannot be made refuses the replay and sends nothing.
    const other = await f.uploaded(gcode(`offline ${f.farm}`), 'other.gcode')
    offline.add(f.first)
    expect(await f.submit(f.far.id, other)).toMatchObject({
      ok: false,
      problem: 'service-unavailable',
    })
    expect(f.sent.issued).toHaveLength(2)
  })

  it('#916: integration uploads and copies stay inside the library quota', async () => {
    const f = await farmFixture()
    const one = gcode(`quota one ${f.farm}`)
    const two = gcode(`quota two ${f.farm}`)
    const refused = {
      ok: false,
      problem: 'payload-too-large',
      reason: 'quota-exceeded',
    }

    await f.library.setSettings(f.principal, f.farm, 'server')
    await root`UPDATE farm.library_settings SET quota_bytes = ${one.length} WHERE farm_id = ${f.farm}`
    await f.uploaded(one, 'one.gcode')
    expect(await f.upload(two, 'two.gcode')).toEqual(refused)
    expect(await (await createBlobStore(directory)).has(sha(two))).toBe(false)
    expect(await f.blobRows(two)).toEqual([])
    // Bytes already kept never count again.
    expect(await f.upload(one, 'one.gcode')).toMatchObject({ ok: true })

    await f.library.setSettings(f.principal, f.farm, 'connector')
    for (const agent of [f.first, f.second])
      await root`INSERT INTO farm.library_connector_storage (farm_id, agent_id, quota_bytes, used_bytes, reported_at)
        VALUES (${f.farm}, ${agent}, 1000000, ${agent === f.first ? 0 : 1000000}, 1)`
    const version = await f.uploaded(two, 'two.gcode')
    expect(await f.submit(f.far.id, version)).toMatchObject({
      ok: false,
      reason: { detail: 'quota-exceeded' },
    })
    expect(puts).toEqual([f.first])
    await root`UPDATE farm.library_connector_storage SET used_bytes = 1000000 WHERE farm_id = ${f.farm}`
    expect(await f.upload(gcode(`quota full ${f.farm}`))).toEqual(refused)
    expect(puts).toEqual([f.first])
  })

  it('#916: uploading a purged file again makes it printable and keeps it', async () => {
    const f = await farmFixture()
    const bytes = gcode(`purged ${f.farm}`)
    const blobs = await createBlobStore(directory)
    await f.library.setSettings(f.principal, f.farm, 'server')
    const old = await f.uploaded(bytes)
    await f.remove(old)
    await f.retention(31 * DAY_MS)
    expect(await blobs.has(sha(bytes))).toBe(false)
    expect(await f.blobRows(bytes)).toEqual([{ agent: null, purged: true }])

    const again = await f.uploaded(bytes)
    expect(again).not.toBe(old)
    expect(await f.library.version(again)).toMatchObject({ id: again })
    await f.retention(31 * DAY_MS)
    expect(await blobs.has(sha(bytes))).toBe(true)
    expect(await f.blobRows(bytes)).toEqual([{ agent: null, purged: false }])
  })

  it('#917: approval refuses a version removed while the job was held', async () => {
    const f = await farmFixture()
    const version = await f.uploaded(gcode(`held ${f.farm}`))
    const submitted = await f.submit(f.near.id, version)
    if (!submitted.ok) throw new Error(submitted.problem)
    expect(submitted.job.status).toBe('held')
    await f.remove(version)

    const approvals = new IntegrationApprovalService({
      store: new PostgresIntegrationApprovals(api),
      envelopes: f.sent.envelopes,
    })
    expect(
      await approvals.decide(f.owner, f.farm, submitted.job.id, 'approve'),
    ).toEqual({ ok: false, problem: 'version-unavailable' })
    expect(f.sent.issued).toEqual([])
    const [job] = await root<{ status: string }[]>`
      SELECT status FROM farm.integration_jobs WHERE id = ${submitted.job.id}`
    expect(job?.status).toBe('rejected')
    const [audit] = await root<{ decision: string }[]>`
      SELECT details->>'approvalDecision' AS decision FROM farm.integration_audit
      WHERE resource_id = ${submitted.job.id} AND action = 'approval.decided'`
    expect(audit?.decision).toBe('version-unavailable')
  })
})
