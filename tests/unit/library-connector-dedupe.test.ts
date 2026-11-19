import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PrintFileMetadata } from '../../packages/shared/src/print-file/metadata.ts'
import { withNetworkGuard } from '../../packages/sim-tools/src/mocks/network-guard.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import {
  BlobStoreError,
  createBlobStore,
  type BlobStore,
} from '../../apps/farm/server/utils/library/blob-store.ts'
import {
  libraryRoutes,
  type ConnectorLibraryRelay,
  type LibraryOperation,
  type LibraryRuntime,
  type LibraryStore,
} from '../../apps/farm/server/utils/library/routes.ts'
import {
  PostgresLibrary,
  type LibraryItem,
  type LibraryLocation,
  type LibrarySettings,
  type LibraryVersion,
  type StorageMode,
} from '../../apps/farm/server/utils/library/store.ts'
import { serveTestServer, type TestServer } from './serve.ts'

vi.mock('../../apps/farm/server/services/authenticated-session.ts', () => ({
  authResponse: (event: { res: { headers: Headers } }) =>
    event.res.headers.set('Cache-Control', 'no-store'),
  authenticatedSession: vi.fn(),
  sealedSessionRecordId: async (event: { req: Request }) => {
    const id = /session=([\w-]+)/.exec(
      event.req.headers.get('cookie') ?? '',
    )?.[1]
    if (!id) throw Object.assign(new Error('Entre novamente.'), { status: 401 })
    return id
  },
}))

const farmA = '11111111-1111-4111-8111-111111111111'
const agentA = '33333333-3333-4333-8333-333333333333'
const agentB = '55555555-5555-4555-8555-555555555555'
const origin = 'https://farm.test'
const auth = {
  origin,
  idleTimeoutMs: 60_000,
  credentials: { consumeLimit: vi.fn(async () => true) },
} as unknown as AuthRuntime

interface BlobRow {
  farmId: string
  sha256: string
  sizeBytes: number
  storageLocation: StorageMode
  agentId: string | null
  createdAt: number
  purgedAt: number | null
}
interface VersionRow {
  id: string
  farmId: string
  itemId: string
  versionNumber: number
  sha256: string
  sizeBytes: number
  storageLocation: StorageMode
  agentId: string | null
  originalName: string
  kind: 'gcode' | '3mf'
  plateCount: number
  metadata: PrintFileMetadata
  notes: string
  uploadedBy: string
  createdAt: number
  deletedAt: number | null
}
interface DbState {
  settings: Map<string, LibrarySettings>
  items: (LibraryItem & { farmId: string })[]
  blobs: BlobRow[]
  versions: VersionRow[]
  connectorStorage: Map<
    string,
    { quotaBytes: number; usedBytes: number; reportedAt: number }
  >
  enrolledAgents: Set<string>
  beforeInsertVersion?: (() => void) | undefined
}

const FRAGMENT = Symbol('fragment')
const JSON_VAL = Symbol('json')

function flattenQuery(
  strings: TemplateStringsArray,
  values: unknown[],
): { text: string; params: unknown[] } {
  let text = ''
  const params: unknown[] = []
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i < values.length) {
      const value = values[i] as Record<symbol, unknown> | undefined
      if (value && typeof value === 'object' && FRAGMENT in value) {
        const frag = value[FRAGMENT] as { text: string; params: unknown[] }
        text += frag.text
        params.push(...frag.params)
      } else if (value && typeof value === 'object' && JSON_VAL in value) {
        text += '?'
        params.push(value[JSON_VAL])
      } else {
        text += '?'
        params.push(value)
      }
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), params }
}

/** In-memory PostgreSQL stand-in enforcing 0056/0071 per-location blob & version invariants. */
function createFakeSql(state: DbState): Sql {
  let now = 1_000
  const blobKey = (
    farmId: string,
    sha256: string,
    location: StorageMode,
    agentId: string | null,
  ) => `${farmId}:${sha256}:${location}:${agentId ?? 'server'}`

  const joinVersion = (v: VersionRow) => {
    const blob = state.blobs.find(
      (b) =>
        b.farmId === v.farmId &&
        b.sha256 === v.sha256 &&
        b.storageLocation === v.storageLocation &&
        (b.agentId ?? null) === (v.agentId ?? null),
    )
    if (!blob) throw new Error('missing matching blob for version')
    return {
      ...v,
      agentId: v.agentId ?? blob.agentId,
      hasThumbnail: Boolean(v.metadata?.thumbnail),
      purgedAt: blob.purgedAt,
    }
  }

  const execute = async (text: string, params: unknown[]) => {
    if (text.startsWith('SET LOCAL') || text.includes('pg_advisory_xact_lock'))
      return []
    if (text.includes('FROM farm.session_accounts'))
      return [{ id: 'acc-owner', sessionVersion: 0, disabled: false }]
    if (text.includes('FROM farm.account_sessions'))
      return [
        {
          id: params[0],
          accountId: 'acc-owner',
          accountVersion: 0,
          createdAt: 100,
          lastSeenAt: 100,
          absoluteExpiresAt: 10_000_000,
          revokedAt: null,
        },
      ]
    if (text.startsWith('UPDATE farm.account_sessions')) return []
    if (text.includes('FROM farm.memberships'))
      return params[0] === farmA ? [{ role: 'owner', revoked_at: null }] : []
    if (text.includes('FROM farm.connector_enrollments'))
      return state.enrolledAgents.has(`${params[0]}:${params[1]}`) ? [{}] : []
    if (text.includes('FROM farm.library_settings')) {
      const s = state.settings.get(params[0] as string)
      return s ? [s] : []
    }
    if (text.startsWith('INSERT INTO farm.library_settings')) {
      const [farmId, storageMode, quotaBytes, retentionDays, keepVersions] =
        params as [string, StorageMode, number, number, number | null]
      state.settings.set(farmId, {
        storageMode,
        quotaBytes,
        retentionDays,
        keepVersions,
      })
      return []
    }
    if (text.includes('GROUP BY storage_location, agent_id')) {
      const farmId = params[0] as string
      const groups = new Map<string, LibraryLocation>()
      for (const b of state.blobs) {
        if (b.farmId !== farmId) continue
        const key = `${b.storageLocation}:${b.agentId}`
        const current = groups.get(key) ?? {
          location: b.storageLocation,
          agentId: b.agentId,
          files: 0,
          bytes: 0,
        }
        groups.set(key, {
          ...current,
          files: current.files + 1,
          bytes: current.bytes + b.sizeBytes,
        })
      }
      return [...groups.values()].sort(
        (a, b) =>
          a.location.localeCompare(b.location) ||
          (a.agentId ?? '').localeCompare(b.agentId ?? ''),
      )
    }
    if (
      text.startsWith(
        'SELECT storage_location AS "storageLocation", agent_id AS "agentId"',
      )
    ) {
      const [farmId, sha256] = params as [string, string]
      return state.blobs
        .filter((b) => b.farmId === farmId && b.sha256 === sha256)
        .sort(
          (a, b) =>
            a.createdAt - b.createdAt ||
            a.storageLocation.localeCompare(b.storageLocation) ||
            (a.agentId ?? '').localeCompare(b.agentId ?? ''),
        )
        .map((b) => ({
          storageLocation: b.storageLocation,
          agentId: b.agentId,
          sizeBytes: b.sizeBytes,
          purgedAt: b.purgedAt,
        }))
    }
    if (text.includes('COALESCE(sum(size_bytes), 0)')) {
      const farmId = params[0] as string
      const used = state.blobs
        .filter(
          (b) =>
            b.farmId === farmId &&
            b.storageLocation === 'server' &&
            b.purgedAt === null,
        )
        .reduce((sum, b) => sum + b.sizeBytes, 0)
      return [{ used }]
    }
    if (text.includes('FROM farm.library_connector_storage')) {
      if (text.includes('AND agent_id=')) {
        const row = state.connectorStorage.get(`${params[0]}:${params[1]}`)
        return row
          ? [{ usedBytes: row.usedBytes, quotaBytes: row.quotaBytes }]
          : []
      }
      const prefix = `${params[0]}:`
      return [...state.connectorStorage.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ agentId: k.slice(prefix.length), ...v }))
    }
    if (text.startsWith('UPDATE farm.library_blobs SET purged_at=NULL')) {
      const [farmId, sha256, location, maybeAgentId] = params as [
        string,
        string,
        StorageMode,
        string?,
      ]
      const agentId = location === 'connector' ? (maybeAgentId ?? null) : null
      const blob = state.blobs.find(
        (b) =>
          b.farmId === farmId &&
          b.sha256 === sha256 &&
          b.storageLocation === location &&
          b.agentId === agentId,
      )
      if (blob) blob.purgedAt = null
      return []
    }
    if (text.startsWith('INSERT INTO farm.library_blobs')) {
      const [farmId, sha256, sizeBytes, storageLocation, agentId, createdAt] =
        params as [string, string, number, StorageMode, string | null, number]
      if ((storageLocation === 'connector') !== (agentId !== null))
        throw new Error('library_blobs check constraint violated')
      const key = blobKey(farmId, sha256, storageLocation, agentId)
      if (
        state.blobs.some(
          (b) =>
            blobKey(b.farmId, b.sha256, b.storageLocation, b.agentId) === key,
        )
      )
        throw new Error(
          'duplicate key value violates unique constraint library_blobs_pkey',
        )
      state.blobs.push({
        farmId,
        sha256,
        sizeBytes,
        storageLocation,
        agentId,
        createdAt,
        purgedAt: null,
      })
      return []
    }
    if (
      text.includes('FROM farm.library_items WHERE farm_id=') &&
      text.includes('AND id=')
    ) {
      const [farmId, itemId] = params as [string, string]
      return state.items.filter((i) => i.farmId === farmId && i.id === itemId)
    }
    if (text.startsWith('INSERT INTO farm.library_items')) {
      const [id, farmId, title, tags, , createdAt] = params as [
        string,
        string,
        string,
        string[],
        string,
        number,
      ]
      const item = { id, farmId, title, tags, archived: false, createdAt }
      state.items.push(item)
      return [{ id, title, tags, archived: false, createdAt }]
    }
    if (text.includes('COALESCE(max(version_number), 0)::int + 1')) {
      const itemId = params[0] as string
      const max = state.versions
        .filter((v) => v.itemId === itemId)
        .reduce((m, v) => Math.max(m, v.versionNumber), 0)
      return [{ n: max + 1 }]
    }
    if (text.startsWith('INSERT INTO farm.library_versions')) {
      state.beforeInsertVersion?.()
      const [
        id,
        farmId,
        itemId,
        versionNumber,
        sha256,
        sizeBytes,
        storageLocation,
        agentId,
        originalName,
        kind,
        plateCount,
        metadata,
        notes,
        uploadedBy,
        createdAt,
      ] = params as [
        string,
        string,
        string,
        number,
        string,
        number,
        StorageMode,
        string | null,
        string,
        'gcode' | '3mf',
        number,
        PrintFileMetadata,
        string,
        string,
        number,
      ]
      if ((storageLocation === 'connector') !== (agentId !== null))
        throw new Error('library_versions_location_agent_check violated')
      const blobExists = state.blobs.some(
        (b) =>
          b.farmId === farmId &&
          b.sha256 === sha256 &&
          b.storageLocation === storageLocation &&
          b.sizeBytes === sizeBytes &&
          b.agentId === agentId,
      )
      if (!blobExists)
        throw new Error(
          'violates foreign key constraint library_versions_blob_location_fkey',
        )
      state.versions.push({
        id,
        farmId,
        itemId,
        versionNumber,
        sha256,
        sizeBytes,
        storageLocation,
        agentId,
        originalName,
        kind,
        plateCount,
        metadata,
        notes,
        uploadedBy,
        createdAt: createdAt || ++now,
        deletedAt: null,
      })
      return []
    }
    if (
      text.includes('FROM farm.library_versions v JOIN farm.library_blobs b')
    ) {
      if (text.includes('WHERE v.id=')) {
        const id = params[0] as string
        return state.versions.filter((v) => v.id === id).map(joinVersion)
      }
      if (text.includes('AND v.id=')) {
        const [farmId, id] = params as [string, string]
        return state.versions
          .filter(
            (v) => v.farmId === farmId && v.id === id && v.deletedAt === null,
          )
          .map(joinVersion)
      }
      if (text.includes('AND v.item_id=')) {
        const [farmId, itemId, includeDeleted] = params as [
          string,
          string,
          boolean,
        ]
        return state.versions
          .filter(
            (v) =>
              v.farmId === farmId &&
              v.itemId === itemId &&
              (includeDeleted || v.deletedAt === null),
          )
          .sort((a, b) => b.versionNumber - a.versionNumber)
          .map(joinVersion)
      }
    }
    throw new Error(`Unexpected SQL statement in fakeSql: ${text}`)
  }

  const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = flattenQuery(strings, values)
    let pending: Promise<unknown[]> | undefined
    const run = () => (pending ??= execute(flat.text, flat.params))
    return {
      [FRAGMENT]: flat,
      then: (
        onFulfilled?: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => run().then(onFulfilled, onRejected),
      catch: (onRejected?: (reason: unknown) => unknown) =>
        run().catch(onRejected),
      finally: (onFinally?: () => void) => run().finally(onFinally),
    }
  }
  const sql = Object.assign(query, {
    json: (value: unknown) => ({ [JSON_VAL]: value }),
    begin: async <T>(work: (tx: unknown) => Promise<T>) => {
      const snapshot: DbState = {
        settings: new Map([...state.settings].map(([k, v]) => [k, { ...v }])),
        items: structuredClone(state.items),
        blobs: structuredClone(state.blobs),
        versions: structuredClone(state.versions),
        connectorStorage: new Map(
          [...state.connectorStorage].map(([k, v]) => [k, { ...v }]),
        ),
        enrolledAgents: new Set(state.enrolledAgents),
        beforeInsertVersion: state.beforeInsertVersion,
      }
      try {
        return await work(sql)
      } catch (error) {
        state.settings = snapshot.settings
        state.items = snapshot.items
        state.blobs = snapshot.blobs
        state.versions = snapshot.versions
        state.connectorStorage = snapshot.connectorStorage
        throw error
      }
    },
  }) as unknown as Sql
  return sql
}

/** Multi-agent Connector relay tracking stored files and discards per Connector. */
class MultiAgentConnectorRelay implements ConnectorLibraryRelay {
  readonly filesByAgent = new Map<string, Map<string, Buffer>>()
  readonly discarded: { agentId: string; sha256: string }[] = []

  private filesOf(agentId: string) {
    let map = this.filesByAgent.get(agentId)
    if (!map) {
      map = new Map()
      this.filesByAgent.set(agentId, map)
    }
    return map
  }

  has(agentId: string, sha256: string) {
    return this.filesByAgent.get(agentId)?.has(sha256) ?? false
  }

  async put(input: Parameters<ConnectorLibraryRelay['put']>[0]) {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of input.body) {
      size += chunk.byteLength
      if (size > input.maxBytes) throw new BlobStoreError('too-large', 'big')
      chunks.push(Buffer.from(chunk))
    }
    const data = Buffer.concat(chunks)
    const sha256 = createHash('sha256').update(data).digest('hex')
    const store = this.filesOf(input.agentId)
    const created = !store.has(sha256)
    store.set(sha256, data)
    return { sha256, size, created }
  }

  async read(input: Parameters<ConnectorLibraryRelay['read']>[0]) {
    const data = this.filesByAgent.get(input.agentId)?.get(input.sha256)
    if (!data) throw new Error('missing')
    return data.subarray(input.offset, input.offset + input.length)
  }

  async discard(input: { farmId: string; agentId: string; sha256: string }) {
    this.discarded.push({ agentId: input.agentId, sha256: input.sha256 })
    this.filesByAgent.get(input.agentId)?.delete(input.sha256)
  }
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const gcode = (tag: string) =>
  Buffer.from(
    `; generated by OrcaSlicer 2.1\n; printer_model = Ender 3\n; nozzle_diameter = 0.4\n; filament_type = PLA\n; filament used [g] = 2\n; layer_height = 0.2\nG1 X1 ; ${tag}\n`,
  )

function operation(
  method: string,
  segments: string[],
): {
  op: LibraryOperation
  target: { versionId?: string; itemId?: string }
} | null {
  const [a, b, c] = segments
  if (!a) {
    if (method === 'GET') return { op: 'list', target: {} }
    if (method === 'POST') return { op: 'upload', target: {} }
  } else if (a === 'settings' && !b) {
    if (method === 'GET') return { op: 'settings', target: {} }
    if (method === 'PUT') return { op: 'settings-update', target: {} }
  } else if (a === 'versions' && b && !c) {
    if (method === 'GET') return { op: 'get', target: { versionId: b } }
    if (method === 'DELETE') return { op: 'delete', target: { versionId: b } }
  } else if (a === 'items' && b && c === 'versions' && method === 'GET') {
    return { op: 'versions', target: { itemId: b } }
  }
  return null
}

let dir: string
let server: TestServer | undefined
let state: DbState
let relay: MultiAgentConnectorRelay
let blobs: BlobStore
let runtime: LibraryRuntime
let tick: number

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'library-connector-dedupe-'))
  tick = 1_000
  state = {
    settings: new Map(),
    items: [],
    blobs: [],
    versions: [],
    connectorStorage: new Map(),
    enrolledAgents: new Set([`${farmA}:${agentA}`, `${farmA}:${agentB}`]),
  }
  const sql = createFakeSql(state)
  relay = new MultiAgentConnectorRelay()
  blobs = await createBlobStore(dir)
  runtime = {
    store: new PostgresLibrary(sql, () => ++tick) as unknown as LibraryStore,
    blobs,
    relay,
  }
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const serverFiles = async () => (await readdir(dir)).filter((n) => n !== '.tmp')

async function handle(request: Request, rt: LibraryRuntime) {
  const [, , , farmId = '', , ...rest] = new URL(request.url).pathname.split(
    '/',
  )
  const route = operation(request.method, rest)
  const event = {
    req: request,
    res: { headers: new Headers(), status: undefined as number | undefined },
  } as unknown as Parameters<typeof libraryRoutes>[0]
  try {
    if (!route) throw Object.assign(new Error('nope'), { status: 405 })
    const body = await libraryRoutes(
      event,
      route.op,
      { farmId, ...route.target },
      { auth, runtime: rt },
    )
    const headers = new Headers(event.res.headers)
    headers.set('content-type', 'application/json')
    return new Response(JSON.stringify(body), {
      status: (event.res as { status?: number }).status ?? 200,
      headers,
    })
  } catch (error) {
    const { status = 500, message } = error as {
      status?: number
      message?: string
    }
    return new Response(JSON.stringify({ status, message }), { status })
  }
}

async function serve(rt: LibraryRuntime = runtime) {
  server = await withNetworkGuard(() =>
    serveTestServer((request) => handle(request, rt)),
  )
}

async function call(
  method: string,
  path: string,
  options: {
    query?: Record<string, string>
    body?: BodyInit | object
  } = {},
) {
  if (!server) await serve()
  const url = new URL(`/api/farms/${farmA}/library${path}`, server!.url)
  for (const [k, v] of Object.entries(options.query ?? {}))
    url.searchParams.append(k, v)
  const isJson =
    options.body !== undefined &&
    !(options.body instanceof Uint8Array) &&
    typeof options.body === 'object'
  const response = await fetch(url, {
    method,
    headers: {
      cookie: 'session=owner',
      ...(method === 'GET' ? {} : { origin }),
      ...(options.body !== undefined
        ? {
            'content-type': isJson
              ? 'application/json'
              : 'application/octet-stream',
          }
        : {}),
    },
    ...(options.body === undefined
      ? {}
      : {
          body: (isJson
            ? JSON.stringify(options.body)
            : options.body) as BodyInit,
        }),
  })
  return {
    status: response.status,
    json: async <T = any>() => (await response.json()) as T, // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

type Uploaded = {
  item: LibraryItem
  version: LibraryVersion
  deduplicated: boolean
}

describe('Connector-mode deduplication per location', () => {
  test('server upload followed by Connector mode upload stores and references the Connector copy', async () => {
    const data = gcode('repro-server-then-connector')
    const digest = sha(data)

    expect(
      (await call('PUT', '/settings', { body: { storageMode: 'server' } }))
        .status,
    ).toBe(200)
    const serverUpload = await call('POST', '', {
      query: { name: 'part.gcode' },
      body: data,
    })
    expect(serverUpload.status).toBe(201)
    const first = await serverUpload.json<Uploaded>()
    expect(first.version.storageLocation).toBe('server')
    expect(first.version.agentId).toBeNull()
    expect(first.deduplicated).toBe(false)
    expect(await serverFiles()).toEqual([digest])

    expect(
      (await call('PUT', '/settings', { body: { storageMode: 'connector' } }))
        .status,
    ).toBe(200)

    const connectorUpload = await call('POST', '', {
      query: { name: 'part.gcode', itemId: first.item.id, agentId: agentA },
      body: data,
    })
    expect(connectorUpload.status).toBe(201)
    const second = await connectorUpload.json<Uploaded>()
    expect(second.version.storageLocation).toBe('connector')
    expect(second.version.agentId).toBe(agentA)
    expect(second.deduplicated).toBe(false)
    expect(relay.has(agentA, digest)).toBe(true)
    expect(relay.discarded).toEqual([])

    // Existing server version keeps its recorded location; a repeat on the same Connector deduplicates.
    const repeat = await call('POST', '', {
      query: { name: 'part.gcode', itemId: first.item.id, agentId: agentA },
      body: data,
    })
    expect(repeat.status).toBe(201)
    const third = await repeat.json<Uploaded>()
    expect(third.version.storageLocation).toBe('connector')
    expect(third.version.agentId).toBe(agentA)
    expect(third.deduplicated).toBe(true)
    expect(relay.discarded).toEqual([])

    const versions = await (
      await call('GET', `/items/${first.item.id}/versions`)
    ).json<{ versions: LibraryVersion[] }>()
    expect(
      versions.versions.map((v) => [
        v.versionNumber,
        v.storageLocation,
        v.agentId,
      ]),
    ).toEqual([
      [3, 'connector', agentA],
      [2, 'connector', agentA],
      [1, 'server', null],
    ])

    const settings = await (
      await call('GET', '/settings')
    ).json<{
      locations: LibraryLocation[]
    }>()
    expect(settings.locations).toEqual([
      { location: 'connector', agentId: agentA, files: 1, bytes: data.length },
      { location: 'server', agentId: null, files: 1, bytes: data.length },
    ])
  })

  test('same bytes uploaded to two Connectors stay on both Connectors and each version points to its own', async () => {
    const data = gcode('two-connectors')
    const digest = sha(data)

    const firstRes = await call('POST', '', {
      query: { name: 'dual.gcode', agentId: agentA },
      body: data,
    })
    expect(firstRes.status).toBe(201)
    const first = await firstRes.json<Uploaded>()
    expect(first.version.storageLocation).toBe('connector')
    expect(first.version.agentId).toBe(agentA)
    expect(first.deduplicated).toBe(false)

    const secondRes = await call('POST', '', {
      query: { name: 'dual.gcode', itemId: first.item.id, agentId: agentB },
      body: data,
    })
    expect(secondRes.status).toBe(201)
    const second = await secondRes.json<Uploaded>()
    expect(second.version.storageLocation).toBe('connector')
    expect(second.version.agentId).toBe(agentB)
    expect(second.deduplicated).toBe(false)
    expect(relay.has(agentA, digest)).toBe(true)
    expect(relay.has(agentB, digest)).toBe(true)
    expect(relay.discarded).toEqual([])

    const repeatBRes = await call('POST', '', {
      query: { name: 'dual.gcode', itemId: first.item.id, agentId: agentB },
      body: data,
    })
    expect(repeatBRes.status).toBe(201)
    const repeatB = await repeatBRes.json<Uploaded>()
    expect(repeatB.version.storageLocation).toBe('connector')
    expect(repeatB.version.agentId).toBe(agentB)
    expect(repeatB.deduplicated).toBe(true)

    const v1 = await (
      await call('GET', `/versions/${first.version.id}`)
    ).json<{ version: LibraryVersion }>()
    const v2 = await (
      await call('GET', `/versions/${second.version.id}`)
    ).json<{ version: LibraryVersion }>()
    expect(v1.version.agentId).toBe(agentA)
    expect(v2.version.agentId).toBe(agentB)

    const settings = await (
      await call('GET', '/settings')
    ).json<{
      locations: LibraryLocation[]
    }>()
    expect(settings.locations).toEqual([
      { location: 'connector', agentId: agentA, files: 1, bytes: data.length },
      { location: 'connector', agentId: agentB, files: 1, bytes: data.length },
    ])
  })

  test('never leaves an unreferenced Connector copy behind when indexing fails or disagrees on location', async () => {
    const data = gcode('cleanup-on-failure')
    const digest = sha(data)

    // Seed agentA with the bytes; agentB is over quota.
    expect(
      (
        await call('POST', '', {
          query: { name: 'seed.gcode', agentId: agentA },
          body: data,
        })
      ).status,
    ).toBe(201)

    state.connectorStorage.set(`${farmA}:${agentB}`, {
      quotaBytes: data.length - 1,
      usedBytes: 0,
      reportedAt: 100,
    })
    const overQuota = await call('POST', '', {
      query: { name: 'seed.gcode', agentId: agentB },
      body: data,
    })
    expect(overQuota.status).toBe(507)
    expect(relay.has(agentB, digest)).toBe(false)
    expect(relay.discarded).toEqual([{ agentId: agentB, sha256: digest }])
    expect(relay.has(agentA, digest)).toBe(true)

    // Re-uploading the same bytes to agentA when an unknown itemId fails does not discard agentA's existing file.
    const missingItem = await call('POST', '', {
      query: { name: 'seed.gcode', itemId: randomUUID(), agentId: agentA },
      body: data,
    })
    expect(missingItem.status).toBe(404)
    expect(relay.has(agentA, digest)).toBe(true)
    expect(relay.discarded).toHaveLength(1)

    // Defensive route invariant: if a store ever returned a version pointing elsewhere, discard the created Connector copy.
    const otherBytes = gcode('mismatched-store')
    const otherDigest = sha(otherBytes)
    const mismatchedStore: LibraryStore = {
      ...(runtime.store as unknown as Record<string, unknown>),
      uploadContext: runtime.store.uploadContext.bind(runtime.store),
      addVersion: async () => ({
        ok: true,
        item: {
          id: randomUUID(),
          title: 'mismatched',
          tags: [],
          archived: false,
          createdAt: 1,
        },
        version: {
          id: randomUUID(),
          itemId: randomUUID(),
          versionNumber: 1,
          sha256: otherDigest,
          sizeBytes: otherBytes.length,
          storageLocation: 'server',
          agentId: null,
          originalName: 'm.gcode',
          kind: 'gcode',
          plateCount: 1,
          metadata: {},
          hasThumbnail: false,
          notes: '',
          uploadedBy: 'owner',
          createdAt: 1,
          deletedAt: null,
          purgedAt: null,
        },
        deduplicated: true,
        orphanedServerCopy: false,
      }),
    } as unknown as LibraryStore
    await serve({ ...runtime, store: mismatchedStore })
    const res = await call('POST', '', {
      query: { name: 'm.gcode', agentId: agentB },
      body: otherBytes,
    })
    expect(res.status).toBe(201)
    expect(relay.has(agentB, otherDigest)).toBe(false)
    expect(relay.discarded).toContainEqual({
      agentId: agentB,
      sha256: otherDigest,
    })
  })

  test('server upload still reuses an existing Connector copy and discards the surplus server file', async () => {
    const data = gcode('connector-then-server')

    const connectorRes = await call('POST', '', {
      query: { name: 'c.gcode', agentId: agentA },
      body: data,
    })
    expect(connectorRes.status).toBe(201)

    expect(
      (await call('PUT', '/settings', { body: { storageMode: 'server' } }))
        .status,
    ).toBe(200)

    const serverRes = await call('POST', '', {
      query: { name: 'c.gcode' },
      body: data,
    })
    expect(serverRes.status).toBe(201)
    const uploaded = await serverRes.json<Uploaded>()
    expect(uploaded.version.storageLocation).toBe('connector')
    expect(uploaded.version.agentId).toBe(agentA)
    expect(uploaded.deduplicated).toBe(true)
    expect(await serverFiles()).toEqual([])
  })

  test('restoring a purged Connector copy keeps other locations intact and clears purgedAt only on the chosen Connector', async () => {
    const data = gcode('purged-connector-restore')
    const digest = sha(data)

    expect(
      (await call('PUT', '/settings', { body: { storageMode: 'server' } }))
        .status,
    ).toBe(200)
    expect(
      (await call('POST', '', { query: { name: 's.gcode' }, body: data }))
        .status,
    ).toBe(201)

    expect(
      (await call('PUT', '/settings', { body: { storageMode: 'connector' } }))
        .status,
    ).toBe(200)
    const firstConnector = await (
      await call('POST', '', {
        query: { name: 'a.gcode', agentId: agentA },
        body: data,
      })
    ).json<Uploaded>()
    expect(firstConnector.version.agentId).toBe(agentA)

    // Simulate retention purging agentA's copy while the server copy stays live.
    const blobA = state.blobs.find(
      (b) =>
        b.sha256 === digest &&
        b.storageLocation === 'connector' &&
        b.agentId === agentA,
    )!
    blobA.purgedAt = 999
    relay.filesByAgent.get(agentA)?.delete(digest)

    const restoredRes = await call('POST', '', {
      query: { name: 'a.gcode', agentId: agentA },
      body: data,
    })
    expect(restoredRes.status).toBe(201)
    const restored = await restoredRes.json<Uploaded>()
    expect(restored.version.storageLocation).toBe('connector')
    expect(restored.version.agentId).toBe(agentA)
    expect(restored.version.purgedAt).toBeNull()
    expect(restored.deduplicated).toBe(false)
    expect(relay.has(agentA, digest)).toBe(true)
    expect(blobA.purgedAt).toBeNull()
  })
})
