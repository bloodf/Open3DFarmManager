/**
 * #935: the #932/#933 follow-ups. The only printers are simulators or none at
 * all: nothing here sends a command.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
import { createBlobStore } from '../../apps/farm/server/utils/library/blob-store.ts'
import { connectorLibraryRelay } from '../../apps/farm/server/utils/library/connector-relay.ts'
import {
  isPurgeable,
  runLibraryRetention,
  type BlobFacts,
} from '../../apps/farm/server/utils/library/retention.ts'
import { libraryRoutes } from '../../apps/farm/server/utils/library/routes.ts'
import { PostgresLibrary } from '../../apps/farm/server/utils/library/store.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  disposablePostgres,
  findPostgresBin,
  getFreePort,
} from '../helpers/disposable-postgres.ts'
import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'

let postgresReady = false
try {
  if (process.env.OPENFARM_PG !== 'docker') findPostgresBin()
  postgresReady = true
} catch {
  // The unit suite also runs on hosts with no PostgreSQL executable.
}

const exec = promisify(execFile)
const sha = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex')
const gcode = (label: string) =>
  Buffer.from(`; ${label}\nG28\n${'G1 X10 Y10\n'.repeat(20)}`)
const DAY_MS = 86_400_000

const directory = await mkdtemp(join(tmpdir(), 'rv-935-'))
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

// #926: the real seed, the real sandbox build and a real Connector, on native
// PostgreSQL without Docker.
it.skipIf(!postgresReady)(
  '#926: the seeded sandbox app answers 201 to a library upload',
  async () => {
    const pg = disposablePostgres({
      ...vitestPostgresOptions('openfarm-rv-935-sandbox'),
      isolated: true,
      through: false,
    })
    const sandbox = await mkdtemp(join(tmpdir(), 'rv-935-sandbox-'))
    const children: ChildProcess[] = []
    let sim: Awaited<ReturnType<typeof startMoonrakerMock>> | undefined
    let logs = ''
    // Vitest's own variables would change what the build and the app do.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !/^(NODE_ENV|VITEST.*|TEST|MODE|DEV|PROD|SSR|BASE_URL)$/.test(name),
      ),
    )
    try {
      sim = await startMoonrakerMock({ initial: { state: 'standby' } })
      await mkdir(join(sandbox, 'connector-data'))
      const sql = await pg.start()
      const port = await getFreePort()
      const origin = `https://127.0.0.1:${port}`
      await exec('openssl', [
        ...['req', '-x509', '-newkey', 'ec'],
        ...['-pkeyopt', 'ec_paramgen_curve:P-256', '-noenc'],
        ...['-keyout', join(sandbox, 'tls.key')],
        ...['-out', join(sandbox, 'tls.crt')],
        ...['-days', '1', '-subj', '/CN=127.0.0.1'],
        ...['-addext', 'subjectAltName=IP:127.0.0.1'],
      ])
      await runMigrations(sql, await loadMigrationCatalog(), { kind: 'up' })
      await seedSandbox(
        sql,
        new URL(`postgres://fixture:fixture@127.0.0.1:${pg.port}/fixture`),
        sandbox,
        { local: true, origin, moonraker: sim.origin },
      )
      const appEnv = Object.fromEntries(
        (await readFile(join(sandbox, 'app.env'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => {
            const at = line.indexOf('=')
            return [line.slice(0, at), line.slice(at + 1)]
          }),
      )
      const client = JSON.parse(
        await readFile(join(sandbox, 'client.json'), 'utf8'),
      )

      // #941: the seeded credential itself carries the library scopes.
      const basic = Buffer.from(
        `${client.clientId}:${client.clientSecret}`,
      ).toString('base64')

      const output = join(sandbox, 'sandbox-output')
      await exec('npx', ['nuxt', 'build', 'infra/sandbox'], {
        env: { ...env, SANDBOX_OUTPUT_DIR: output },
        timeout: 240_000,
        maxBuffer: 64 * 1024 * 1024,
      })
      const cert = readFileSync(join(sandbox, 'tls.crt'))
      const launch = (args: string[], extra: Record<string, string>) => {
        const child = spawn(process.execPath, args, {
          env: { ...env, ...extra },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        children.push(child)
        for (const stream of [child.stdout, child.stderr])
          stream?.on('data', (chunk) => {
            logs = (logs + String(chunk)).slice(-8000)
          })
      }
      launch([join(output, 'server', 'index.mjs')], {
        ...appEnv,
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: String(port),
        NITRO_SSL_CERT: cert.toString(),
        NITRO_SSL_KEY: readFileSync(join(sandbox, 'tls.key'), 'utf8'),
      })
      const call = (
        path: string,
        options: {
          method?: string
          headers?: Record<string, string>
          body?: string
        } = {},
      ) =>
        new Promise<{ status: number; text: string }>((resolve, reject) => {
          const req = httpsRequest(
            origin + path,
            { ...options, ca: cert },
            (res) => {
              let text = ''
              res.setEncoding('utf8')
              res.on('data', (chunk) => (text += chunk))
              res.on('end', () => resolve({ status: res.statusCode!, text }))
            },
          )
          req.on('error', reject)
          req.end(options.body)
        })
      const wait = async (label: string, check: () => Promise<boolean>) => {
        const end = Date.now() + 60_000
        while (Date.now() < end) {
          if (await check().catch(() => false)) return
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        throw new Error(`${label} timed out\n${logs}`)
      }
      await wait('app', async () => (await call('/readyz')).status === 200)
      launch(
        [
          'packages/connector/src/cli.ts',
          'run',
          ...['--config', join(sandbox, 'runtime.json')],
          ...['--credential-file', join(sandbox, 'credential.json')],
          ...['--data-dir', join(sandbox, 'connector-data')],
        ],
        { NODE_EXTRA_CA_CERTS: join(sandbox, 'tls.crt') },
      )
      // The Connector reports its storage as its library relay starts.
      await wait(
        'library relay',
        async () =>
          (await sql`SELECT 1 FROM farm.library_connector_storage`).length > 0,
      )

      const token = await call('/api/integrations/v1/oauth/token', {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials&scope=library%3Aread+library%3Awrite',
      })
      expect(token.status, token.text).toBe(200)
      const bytes = gcode('sandbox upload')
      let uploaded = { status: 0, text: '' }
      // 503 until the Connector's first poll arrives; the upload deduplicates.
      await wait('upload', async () => {
        uploaded = await call('/api/integrations/v1/library', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${JSON.parse(token.text).access_token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            farmId: client.farmId,
            name: 'approved.gcode',
            contentBase64: bytes.toString('base64'),
          }),
        })
        return uploaded.status !== 503
      })
      expect(uploaded.status, `${uploaded.text}\n${logs}`).toBe(201)
      const stored = await readdir(join(sandbox, 'connector-data'), {
        recursive: true,
      })
      expect(stored.some((path) => path.endsWith(sha(bytes)))).toBe(true)
    } finally {
      for (const child of children) child.kill('SIGTERM')
      await Promise.all(
        children.map((child) =>
          child.exitCode === null && child.signalCode === null
            ? once(child, 'exit')
            : undefined,
        ),
      )
      await Promise.allSettled([sim?.close(), pg.stop()])
      await rm(sandbox, { recursive: true, force: true })
    }
  },
  360_000,
)

// #935: the SQL prefilter and `isPurgeable` both protect a Connector copy of a
// live file. Each has its own test, so reverting either one alone fails.
it('#935: isPurgeable keeps a Connector copy of a live file', () => {
  const facts: BlobFacts = {
    farmId: randomUUID(),
    sha256: '0'.repeat(64),
    sizeBytes: 1,
    location: 'connector',
    agentId: randomUUID(),
    createdAt: 0,
    retentionDays: 30,
    refs: 0,
    live: false,
    newestDeletedAt: null,
  }
  expect(isPurgeable(facts, DAY_MS)).toBe(true)
  expect(isPurgeable({ ...facts, copyOfLive: true }, DAY_MS)).toBe(false)
})

describe.skipIf(!postgresReady)('with PostgreSQL', () => {
  const database = postgresReady
    ? disposablePostgres({
        ...vitestPostgresOptions('openfarm-rv-935'),
        isolated: true,
      })
    : undefined
  let root: Sql
  /** A login with only the integration role, so missing grants fail. */
  let api: Sql

  beforeAll(async () => {
    root = await database!.start()
    await root.unsafe(
      `CREATE ROLE rv_935_api LOGIN PASSWORD 'rv-935-fixture' IN ROLE farm_integration_jobs`,
    )
    const url = new URL(database!.connectionString)
    url.username = 'rv_935_api'
    url.password = 'rv-935-fixture'
    api = postgres(url.toString(), { max: 3, onnotice: () => {} })
  }, 60_000)
  afterAll(async () => {
    await api?.end({ timeout: 3 })
    await database?.stop()
  })
  // Each retention run sees only its own test's rows.
  beforeEach(async () => {
    await root`UPDATE farm.library_blobs SET purged_at = 1 WHERE purged_at IS NULL`
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
      VALUES (${randomUUID()}, ${farm}, ${first}, 'rv-935', 1, ${owner})`
    const app = randomUUID()
    await root`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by)
      VALUES (${app}, ${farm}, 'rv 935', false, 1, ${owner})`
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
    const retention = async (later: number, batchSize = 100) =>
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
        { batchSize },
      )
    const blobRows = (bytes: Buffer) =>
      root<{ agent: string | null; purged: boolean }[]>`
        SELECT agent_id::text AS agent, purged_at IS NOT NULL AS purged
        FROM farm.library_blobs WHERE farm_id = ${farm} AND sha256 = ${sha(bytes)}`
    const remove = () =>
      root`UPDATE farm.library_versions SET deleted_at = ${Date.now()} WHERE farm_id = ${farm}`
    return {
      owner,
      farm,
      first,
      second,
      principal,
      retention,
      blobRows,
      remove,
    }
  }

  /** An upload during which `meanwhile` runs between `retain` and `addVersion`. */
  function uploader(
    principal: IntegrationPrincipal,
    farmId: string,
    meanwhile: () => Promise<unknown> = async () => {},
  ) {
    let pending: (() => Promise<unknown>) | undefined = meanwhile
    class Interrupted extends PostgresIntegrationLibrary {
      override async retain(
        ...args: Parameters<PostgresIntegrationLibrary['retain']>
      ) {
        await super.retain(...args)
        const run = pending
        pending = undefined
        await run?.()
      }
    }
    const library = new IntegrationLibraryService(new Interrupted(api))
    return {
      library,
      upload: async (bytes: Buffer, name = 'part.gcode') => {
        const result = await library.upload(
          principal,
          { farmId, name, bytes },
          1 << 20,
        )
        if (!result.ok) throw new Error(result.problem)
        return result.value.version.id
      },
    }
  }

  it('#935: concurrent copies cannot push a Connector over its quota', async () => {
    const f = await farmFixture()
    const { library, upload } = uploader(f.principal, f.farm)
    const one = gcode(`copy one ${f.farm}`)
    const two = gcode(`copy two ${f.farm}`)
    const versions = [
      await upload(one, 'one.gcode'),
      await upload(two, 'two.gcode'),
    ]
    // Room on the target for one of the two files.
    await root`INSERT INTO farm.library_connector_storage (farm_id, agent_id, quota_bytes, used_bytes, reported_at)
      VALUES (${f.farm}, ${f.second}, ${one.length}, 0, ${Date.now()})`
    // Both transfers are in flight before either is recorded.
    let arrived = 0
    let release!: () => void
    const both = new Promise<void>((resolve) => (release = resolve))
    afterPut = async () => {
      if (++arrived === 2) release()
      await both
    }

    const placed = await Promise.all(
      versions.map((id) => library.placeOn(id, f.second)),
    )
    expect([...placed].sort()).toEqual(['quota-exceeded', 'ready'])
    const recorded = await root<{ sha256: string }[]>`
      SELECT sha256 FROM farm.library_blobs WHERE agent_id = ${f.second}`
    expect(recorded).toHaveLength(1)
    // The refused file does not stay on the Connector.
    expect([...disk(f.second).keys()]).toEqual([recorded[0]!.sha256])
  })

  it.each(['server', 'connector'] as const)(
    '#935: a %s-mode purge between the byte write and addVersion leaves the file',
    async (mode) => {
      const f = await farmFixture()
      const bytes = gcode(`race ${f.farm}`)
      const blobs = await createBlobStore(directory)
      const has = async () =>
        mode === 'server'
          ? blobs.has(sha(bytes))
          : disk(f.first).has(sha(bytes))
      const plain = uploader(f.principal, f.farm)
      await plain.library.setSettings(f.principal, f.farm, mode)
      await plain.upload(bytes)
      await f.remove()

      let purged = 0
      const racing = uploader(f.principal, f.farm, async () => {
        purged = (await f.retention(31 * DAY_MS)).blobsPurged
        expect(await has()).toBe(false)
      })
      const version = await racing.upload(bytes)

      expect(purged).toBe(1)
      expect(await racing.library.version(version)).toMatchObject({
        id: version,
      })
      expect(await f.blobRows(bytes)).toMatchObject([{ purged: false }])
      expect(await has()).toBe(true)
    },
  )

  it('#935: the farm upload refuses to revive a record whose file was purged under it', async () => {
    const f = await farmFixture()
    const now = Date.now()
    state.session = randomUUID()
    await root`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at)
      VALUES (${state.session}, ${f.owner}, 0, ${now}, ${now}, ${now + 3_600_000})`
    await root`INSERT INTO farm.library_settings (farm_id, storage_mode, quota_bytes, retention_days, updated_by, updated_at)
      VALUES (${f.farm}, 'server', 1000000, 30, ${f.owner}, ${now})`
    const blobs = await createBlobStore(directory)
    const bytes = gcode(`farm race ${f.farm}`)
    let meanwhile: () => Promise<unknown> = async () => {}
    const auth = {
      origin: 'https://farm.test',
      idleTimeoutMs: 3_600_000,
      credentials: { consumeLimit: async () => true },
    } as unknown as AuthRuntime
    const upload = async () => {
      const req = new Request('https://farm.test/api/library?name=part.gcode', {
        method: 'POST',
        headers: {
          origin: auth.origin,
          'content-type': 'application/octet-stream',
        },
        body: bytes,
        duplex: 'half',
      } as RequestInit)
      const res = { headers: new Headers(), status: 200 }
      await libraryRoutes(
        { req, res } as never,
        'upload',
        { farmId: f.farm },
        {
          auth,
          runtime: {
            store: new PostgresLibrary(root),
            blobs: {
              ...blobs,
              async put(...args) {
                const stored = await blobs.put(...args)
                await meanwhile()
                return stored
              },
            },
          },
        },
      )
      return res.status
    }
    expect(await upload()).toBe(201)
    await f.remove()
    meanwhile = () => f.retention(31 * DAY_MS)

    await expect(upload()).rejects.toMatchObject({ status: 503 })
    expect(await f.blobRows(bytes)).toEqual([{ agent: null, purged: true }])

    meanwhile = async () => {}
    expect(await upload()).toBe(201)
    expect(await blobs.has(sha(bytes))).toBe(true)
  })

  it('#935: a protected copy never takes a place in the purge batch', async () => {
    const f = await farmFixture()
    const { upload } = uploader(f.principal, f.farm)
    const live = gcode(`live ${f.farm}`)
    await upload(live)
    const orphan = gcode(`orphan ${f.farm}`)
    // The copy of the live file is the older candidate.
    for (const [bytes, createdAt] of [
      [live, 1],
      [orphan, 2],
    ] as const)
      await root`INSERT INTO farm.library_blobs (farm_id, sha256, size_bytes, storage_location, agent_id, created_at)
        VALUES (${f.farm}, ${sha(bytes)}, ${bytes.length}, 'connector', ${f.second}, ${createdAt})`

    // Without the SQL guard the copy fills the batch of one and is then skipped.
    expect(await f.retention(2 * 3_600_000, 1)).toMatchObject({
      blobsPurged: 1,
      failed: 0,
    })
    expect(await f.blobRows(orphan)).toEqual([
      { agent: f.second, purged: true },
    ])
    expect(await f.blobRows(live)).toContainEqual({
      agent: f.second,
      purged: false,
    })
  })
})
