import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { withNetworkGuard } from '../../packages/sim-tools/src/mocks/network-guard.ts'
import type { PrintFileMetadata } from '../../packages/shared/src/print-file/metadata.ts'
import {
  BlobStoreError,
  createBlobStore,
  type BlobStore,
} from '../../apps/farm/server/utils/library/blob-store.ts'
import {
  LIBRARY_MAX_UPLOAD_BYTES,
  libraryRoutes,
  type ConnectorLibraryRelay,
  type LibraryOperation,
  type LibraryRuntime,
  type LibraryStore,
} from '../../apps/farm/server/utils/library/routes.ts'
import type {
  LibraryItem,
  LibraryLocation,
  LibrarySettings,
  LibraryVersion,
  StorageMode,
} from '../../apps/farm/server/utils/library/store.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import { serveTestServer, type TestServer } from './serve.ts'

vi.mock('../../apps/farm/server/services/authenticated-session.ts', () => ({
  authResponse: (event: { res: { headers: Headers } }) =>
    event.res.headers.set('Cache-Control', 'no-store'),
  authenticatedSession: vi.fn(),
  // The cookie value is the session record id; the fake store maps it to roles.
  sealedSessionRecordId: async (event: { req: Request }) => {
    const id = /session=(\w+)/.exec(event.req.headers.get('cookie') ?? '')?.[1]
    if (!id) throw Object.assign(new Error('Entre novamente.'), { status: 401 })
    return id
  },
}))

const farmA = '11111111-1111-4111-8111-111111111111'
const farmB = '22222222-2222-4222-8222-222222222222'
const agentId = '33333333-3333-4333-8333-333333333333'
const origin = 'https://farm.test'
const auth = {
  origin,
  idleTimeoutMs: 100,
  credentials: { consumeLimit: vi.fn(async () => true) },
} as unknown as AuthRuntime

const roles: Record<string, Record<string, string>> = {
  owner: { [farmA]: 'owner' },
  admin: { [farmA]: 'admin' },
  operator: { [farmA]: 'operator' },
  viewer: { [farmA]: 'viewer' },
  outsider: { [farmB]: 'owner' },
  stranger: {},
}
const MANAGERS = ['owner', 'admin']
const WRITERS = ['owner', 'admin', 'operator']

/** In-process stand-in for PostgresLibrary with the same role, mode, dedupe and paging rules. */
type FakeItem = LibraryItem & { farmId: string }
type FakeVersion = LibraryVersion & { farmId: string }

class FakeLibrary {
  settings = new Map<string, LibrarySettings>()
  items: FakeItem[] = []
  versions: FakeVersion[] = []
  blobs = new Map<
    string,
    { size: number; location: StorageMode; agentId: string | null }
  >()
  agents = new Set([agentId])
  tick = 0
  /** Runs between the mode check and the insert, to simulate a concurrent switch. */
  beforeAdd: (() => void) | undefined
  readonly calls: string[] = []

  private modeOf(farm: string): LibrarySettings {
    return (
      this.settings.get(farm) ?? {
        storageMode: 'connector',
        quotaBytes: 21_474_836_480,
        retentionDays: 30,
        keepVersions: null,
      }
    )
  }
  private role(input: { sessionRecordId: string; farmId: string }) {
    return roles[input.sessionRecordId]?.[input.farmId]
  }
  private locations(farm: string): LibraryLocation[] {
    const rows = new Map<string, LibraryLocation>()
    for (const [key, b] of this.blobs) {
      if (!key.startsWith(farm)) continue
      const id = `${b.location}:${b.agentId}`
      const row = rows.get(id) ?? {
        location: b.location,
        agentId: b.agentId,
        files: 0,
        bytes: 0,
      }
      rows.set(id, { ...row, files: row.files + 1, bytes: row.bytes + b.size })
    }
    return [...rows.values()]
  }

  getSettings: LibraryStore['getSettings'] = async (input) => {
    const role = this.role(input)
    if (!role) return { ok: false, reason: 'forbidden' }
    return {
      ok: true,
      settings: this.modeOf(input.farmId),
      locations: this.locations(input.farmId),
      canManage: MANAGERS.includes(role),
    }
  }
  setSettings: LibraryStore['setSettings'] = async (input) => {
    const role = this.role(input)
    if (!role) return { ok: false, reason: 'forbidden' }
    if (!MANAGERS.includes(role)) return { ok: false, reason: 'denied' }
    const next = {
      ...this.modeOf(input.farmId),
      ...(input.storageMode ? { storageMode: input.storageMode } : {}),
      ...(input.quotaBytes !== undefined
        ? { quotaBytes: input.quotaBytes }
        : {}),
      ...(input.retentionDays !== undefined
        ? { retentionDays: input.retentionDays }
        : {}),
      ...(input.keepVersions !== undefined
        ? { keepVersions: input.keepVersions }
        : {}),
    }
    this.settings.set(input.farmId, next)
    return {
      ok: true,
      settings: next,
      locations: this.locations(input.farmId),
    }
  }
  getUsage: LibraryStore['getUsage'] = async (input) =>
    this.role(input)
      ? {
          ok: true,
          usage: {
            mode: this.modeOf(input.farmId).storageMode,
            usedBytes: 7,
            quotaBytes: 100,
            availableBytes: 93,
            connectors: [],
            unreported: false,
          },
        }
      : { ok: false, reason: 'forbidden' }
  discardUnused: LibraryStore['discardUnused'] = async (file, discard) => {
    const kept = this.blobs.get(`${file.farmId}:${file.sha256}`)
    if (!kept || kept.agentId !== (file.agentId ?? null)) await discard()
  }
  uploadContext: LibraryStore['uploadContext'] = async (input) => {
    this.calls.push('uploadContext')
    const role = this.role(input)
    if (!role) return { ok: false, reason: 'forbidden' }
    if (!WRITERS.includes(role)) return { ok: false, reason: 'denied' }
    const settings = this.modeOf(input.farmId)
    if (settings.storageMode === 'connector') {
      if (!input.agentId) return { ok: false, reason: 'invalid-input' }
      if (!this.agents.has(input.agentId))
        return { ok: false, reason: 'forbidden' }
    }
    return { ok: true, settings }
  }
  addVersion = async (
    input: Parameters<LibraryStore['addVersion']>[0],
  ): Promise<Awaited<ReturnType<LibraryStore['addVersion']>>> => {
    this.calls.push('addVersion')
    const role = this.role(input)
    if (!role) return { ok: false, reason: 'forbidden' }
    if (!WRITERS.includes(role)) return { ok: false, reason: 'denied' }
    const v = input.version
    const farm = input.farmId
    this.beforeAdd?.()
    const settings = this.modeOf(farm)
    if (settings.storageMode !== v.location)
      return { ok: false, reason: 'mode-mismatch' }
    const key = `${farm}:${v.sha256}`
    const existing = this.blobs.get(key)
    if (!existing) {
      const used = [...this.blobs]
        .filter(([k, b]) => k.startsWith(farm) && b.location === 'server')
        .reduce((sum, [, b]) => sum + b.size, 0)
      if (v.location === 'server' && used + v.sizeBytes > settings.quotaBytes)
        return {
          ok: false,
          reason: 'quota-exceeded',
          message: 'Cota da biblioteca excedida no servidor.',
        }
      this.blobs.set(key, {
        size: v.sizeBytes,
        location: v.location,
        agentId: v.agentId ?? null,
      })
    }
    let item = this.items.find((i) => i.id === v.itemId && i.farmId === farm)
    if (v.itemId && !item) return { ok: false, reason: 'not-found' }
    if (!item) {
      item = {
        id: randomUUID(),
        farmId: farm,
        title: v.title!,
        tags: v.tags ?? [],
        archived: false,
        createdAt: ++this.tick,
      }
      this.items.push(item)
    }
    const blob = existing ?? this.blobs.get(key)!
    const version = {
      farmId: farm,
      id: randomUUID(),
      itemId: item.id,
      versionNumber:
        this.versions.filter((x) => x.itemId === item.id).length + 1,
      sha256: v.sha256,
      sizeBytes: v.sizeBytes,
      storageLocation: blob.location,
      agentId: blob.agentId,
      originalName: v.originalName,
      kind: v.kind,
      plateCount: v.plateCount,
      metadata: v.metadata as PrintFileMetadata,
      hasThumbnail: Boolean((v.metadata as PrintFileMetadata).thumbnail),
      notes: v.notes ?? '',
      uploadedBy: input.sessionRecordId,
      createdAt: this.tick,
      deletedAt: null,
      purgedAt: null,
    }
    this.versions.push(version)
    return {
      ok: true,
      item,
      version,
      deduplicated: existing !== undefined,
      orphanedServerCopy:
        existing?.location === 'connector' && v.location === 'server',
    }
  }
  searchItems = async (input: Parameters<LibraryStore['searchItems']>[0]) => {
    if (!this.role(input)) return { ok: false, reason: 'forbidden' }
    const f = input.search ?? {}
    const has = (value: string | undefined, part: string) =>
      (value ?? '').toLowerCase().includes(part.toLowerCase())
    const limit = input.limit ?? 50
    const rows = this.items
      .filter((i) => i.farmId === input.farmId)
      .map((item) => ({
        item,
        latest: this.versions
          .filter((x) => x.itemId === item.id && x.deletedAt === null)
          .sort((a, b) => b.versionNumber - a.versionNumber)[0],
      }))
      .filter(
        (r): r is { item: FakeItem; latest: FakeVersion } =>
          r.latest !== undefined,
      )
      .filter(({ item, latest }) => {
        const tools = latest.metadata.tools ?? []
        return (
          (!f.title || has(item.title, f.title)) &&
          (!f.tag ||
            item.tags.some((t) => t.toLowerCase() === f.tag!.toLowerCase())) &&
          (!f.printerModel ||
            has(latest.metadata.printerModel, f.printerModel)) &&
          (!f.slicer || has(latest.metadata.slicer, f.slicer)) &&
          (!f.material ||
            tools.some(
              (t) =>
                t.filamentType?.toLowerCase() === f.material!.toLowerCase(),
            )) &&
          (f.nozzle === undefined ||
            tools.some((t) => t.nozzleDiameter === f.nozzle))
        )
      })
      .filter(
        ({ item }) =>
          !input.after ||
          item.createdAt < input.after.createdAt ||
          (item.createdAt === input.after.createdAt &&
            item.id > input.after.id),
      )
      .sort(
        (a, b) =>
          b.item.createdAt - a.item.createdAt ||
          (a.item.id < b.item.id ? -1 : 1),
      )
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return {
      ok: true,
      items: page.map(({ item, latest }) => ({
        ...item,
        latest: { ...latest, metadata: stripThumb(latest.metadata) },
      })),
      next:
        rows.length > limit && last
          ? { createdAt: last.item.createdAt, id: last.item.id }
          : null,
    }
  }
  getVersion: LibraryStore['getVersion'] = async (input) => {
    if (!this.role(input)) return { ok: false, reason: 'forbidden' }
    const version = this.versions.find(
      (v) =>
        v.id === input.versionId &&
        v.farmId === input.farmId &&
        v.deletedAt === null,
    )
    const item = this.items.find((i) => i.id === version?.itemId)
    return version && item
      ? { ok: true, version, item }
      : { ok: false, reason: 'not-found' }
  }
  getVersionBySha256: LibraryStore['getVersionBySha256'] = async (input) => {
    if (!this.role(input)) return { ok: false, reason: 'forbidden' }
    const version = this.versions.find(
      (v) =>
        v.sha256 === input.sha256 &&
        v.farmId === input.farmId &&
        v.deletedAt === null,
    )
    const item = this.items.find((i) => i.id === version?.itemId)
    return version && item
      ? { ok: true, version, item }
      : { ok: false, reason: 'not-found' }
  }
  listVersions: LibraryStore['listVersions'] = async (input) => {
    if (!this.role(input)) return { ok: false, reason: 'forbidden' }
    return {
      ok: true,
      versions: this.versions
        .filter(
          (v) =>
            v.farmId === input.farmId &&
            v.itemId === input.itemId &&
            v.deletedAt === null,
        )
        .sort((a, b) => b.versionNumber - a.versionNumber),
    }
  }
  softDeleteVersion: LibraryStore['softDeleteVersion'] = async (input) => {
    const role = this.role(input)
    if (!role) return { ok: false, reason: 'forbidden' }
    if (!MANAGERS.includes(role)) return { ok: false, reason: 'denied' }
    const version = this.versions.find(
      (v) =>
        v.id === input.versionId &&
        v.farmId === input.farmId &&
        v.deletedAt === null,
    )
    if (!version) return { ok: false, reason: 'not-found' }
    version.deletedAt = 1_000
    return { ok: true, deletedAt: 1_000 }
  }
}

function stripThumb(metadata: PrintFileMetadata): PrintFileMetadata {
  const { thumbnail: _thumbnail, ...rest } = metadata
  return rest
}

/** The Connector's own disk: the relay is the only place its bytes exist. */
class FakeConnector implements ConnectorLibraryRelay {
  files = new Map<string, Buffer>()
  discarded: string[] = []
  down = false
  async put(input: Parameters<ConnectorLibraryRelay['put']>[0]) {
    if (this.down) throw new Error('connector offline')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of input.body) {
      size += chunk.byteLength
      if (size > input.maxBytes) throw new BlobStoreError('too-large', 'big')
      chunks.push(Buffer.from(chunk))
    }
    const data = Buffer.concat(chunks)
    const sha256 = createHash('sha256').update(data).digest('hex')
    const created = !this.files.has(sha256)
    this.files.set(sha256, data)
    return { sha256, size, created }
  }
  async read(input: Parameters<ConnectorLibraryRelay['read']>[0]) {
    const data = this.files.get(input.sha256)
    if (!data) throw new Error('missing')
    return data.subarray(input.offset, input.offset + input.length)
  }
  async discard(input: { sha256: string }) {
    this.discarded.push(input.sha256)
    this.files.delete(input.sha256)
  }
}

// --- fixtures

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const gcode = (
  tag: string,
  over: {
    model?: string
    slicer?: string
    nozzle?: number
    material?: string
  } = {},
) =>
  Buffer.from(
    `; generated by ${over.slicer ?? 'OrcaSlicer'} 2.1\n; printer_model = ${over.model ?? 'Ender 3'}\n; nozzle_diameter = ${over.nozzle ?? 0.4}\n; filament_type = ${over.material ?? 'PLA'}\n; filament used [g] = 2\n; layer_height = 0.2\nG1 X1 ; ${tag}\n`,
  )

function zip(files: Record<string, Buffer | string>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const body = deflateRawSync(data)
    const name = Buffer.from(path)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(8, 10)
    head.writeUInt32LE(crc32(data), 16)
    head.writeUInt32LE(body.length, 20)
    head.writeUInt32LE(data.length, 24)
    head.writeUInt16LE(name.length, 28)
    head.writeUInt32LE(offset, 42)
    central.push(head, name)
    parts.push(local, name, body)
    offset += 30 + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(central.length / 2, 8)
  eocd.writeUInt16LE(central.length / 2, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, eocd])
}
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('plate-image'),
])
const threeMf = (tag: string) =>
  zip({
    '[Content_Types].xml': '<Types/>',
    '3D/3dmodel.model': `<model>${tag}</model>`,
    'Metadata/project_settings.config': JSON.stringify({
      printer_model: 'Bambu Lab X1',
      nozzle_diameter: ['0.4'],
      filament_type: ['PETG'],
      filament_colour: ['#00FF00'],
    }),
    'Metadata/slice_info.config': `<config><header><header_item key="X-BBL-Client-Type" value="slicer"/><header_item key="X-BBL-Client-Version" value="01.10"/></header><plate><metadata key="index" value="1"/><metadata key="prediction" value="600"/><filament id="1" type="PETG" color="#00FF00" used_g="3"/></plate></config>`,
    'Metadata/plate_1.gcode':
      '; generated by BambuStudio 01.10\n; layer_height = 0.2\n',
    'Metadata/plate_1.png': PNG,
  })

// --- harness

let dir: string
let server: TestServer | undefined
let store: FakeLibrary
let connector: FakeConnector
let blobs: BlobStore
let runtime: LibraryRuntime

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'library-routes-'))
  store = new FakeLibrary()
  connector = new FakeConnector()
  blobs = await createBlobStore(dir)
  runtime = {
    store: store as unknown as LibraryStore,
    blobs,
    relay: connector,
  }
})
afterEach(async () => {
  try {
    await server?.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  server = undefined
})

const files = async () => (await readdir(dir)).filter((n) => n !== '.tmp')

/** Same routing the Nuxt file names give: method + path pick the operation. */
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
  } else if (a === 'replay-source' && !b && method === 'GET') {
    return { op: 'replay-source', target: {} }
  } else if (a === 'settings' && !b) {
    if (method === 'GET') return { op: 'settings', target: {} }
    if (method === 'PUT') return { op: 'settings-update', target: {} }
  } else if (a === 'versions' && b && !c) {
    if (method === 'GET') return { op: 'get', target: { versionId: b } }
    if (method === 'DELETE') return { op: 'delete', target: { versionId: b } }
  } else if (a === 'versions' && b && c === 'thumbnail' && method === 'GET')
    return { op: 'thumbnail', target: { versionId: b } }
  else if (a === 'items' && b && c === 'versions' && method === 'GET')
    return { op: 'versions', target: { itemId: b } }
  return null
}

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
    if (body instanceof Response) {
      body.headers.forEach((v, k) => headers.set(k, v))
      return new Response(
        body.status === 304 ? null : await body.arrayBuffer(),
        {
          status: body.status,
          headers,
        },
      )
    }
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
  const previous = server
  await previous?.stop()
  if (previous) await expect(fetch(previous.url)).rejects.toThrow()
  server = await withNetworkGuard(() =>
    serveTestServer((request) => handle(request, rt)),
  )
}

interface Call {
  farm?: string
  as?: string | null
  query?: Record<string, string | string[]>
  body?: BodyInit | object
  type?: string
  headers?: Record<string, string>
}
async function call(method: string, path: string, c: Call = {}) {
  if (!server) await serve()
  const url = new URL(
    `/api/farms/${c.farm ?? farmA}/library${path}`,
    server!.url,
  )
  for (const [k, v] of Object.entries(c.query ?? {}))
    for (const item of [v].flat()) url.searchParams.append(k, item)
  const json =
    c.body !== undefined &&
    !(c.body instanceof Uint8Array) &&
    typeof c.body === 'object'
  const response = await fetch(url, {
    method,
    headers: {
      ...(c.as === null ? {} : { cookie: `session=${c.as ?? 'owner'}` }),
      ...(method === 'GET' ? {} : { origin }),
      ...(c.body !== undefined
        ? {
            'content-type':
              c.type ??
              (json ? 'application/json' : 'application/octet-stream'),
          }
        : {}),
      ...c.headers,
    },
    ...(c.body === undefined
      ? {}
      : { body: (json ? JSON.stringify(c.body) : c.body) as BodyInit }),
  })
  const type = response.headers.get('content-type') ?? ''
  return {
    status: response.status,
    headers: response.headers,
    text: type.includes('json') ? undefined : undefined,
    json: async <T = any>() => (await response.json()) as T, // eslint-disable-line @typescript-eslint/no-explicit-any
    bytes: async () => Buffer.from(await response.arrayBuffer()),
  }
}

type Uploaded = {
  item: LibraryItem
  version: LibraryVersion
  deduplicated: boolean
}
async function put(
  data: Buffer,
  name: string,
  over: Call & { query?: Record<string, string | string[]> } = {},
) {
  return call('POST', '', {
    ...over,
    body: data,
    query: { name, ...over.query },
  })
}
const useServerMode = () =>
  call('PUT', '/settings', { body: { storageMode: 'server' } })
const useConnectorUpload = { agentId }

describe('storage mode setting', () => {
  test('defaults to Connector mode and tells each role whether it can manage', async () => {
    for (const [who, canManage] of [
      ['owner', true],
      ['admin', true],
      ['operator', false],
      ['viewer', false],
    ] as const) {
      const response = await call('GET', '/settings', { as: who })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({
        settings: {
          storageMode: 'connector',
          quotaBytes: 21_474_836_480,
          retentionDays: 30,
        },
        canManage,
      })
      // Used and available space is shown to the people who manage the farm.
      expect(body.usage?.availableBytes).toBe(canManage ? 93 : undefined)
    }
  })

  test('only owner and admin change it', async () => {
    for (const who of ['owner', 'admin'] as const)
      expect(
        (
          await call('PUT', '/settings', {
            as: who,
            body: { storageMode: 'server' },
          })
        ).status,
      ).toBe(200)
    for (const who of ['operator', 'viewer'] as const) {
      expect(
        (
          await call('PUT', '/settings', {
            as: who,
            body: { storageMode: 'connector' },
          })
        ).status,
      ).toBe(403)
    }
    expect(store.settings.get(farmA)?.storageMode).toBe('server')
  })

  test('keeps the newest N versions setting and clears it with null', async () => {
    const set = await call('PUT', '/settings', { body: { keepVersions: 5 } })
    expect((await set.json()).settings.keepVersions).toBe(5)
    const cleared = await call('PUT', '/settings', {
      body: { keepVersions: null },
    })
    expect((await cleared.json()).settings.keepVersions).toBeNull()
  })

  test('rejects unknown, invalid and unbounded input', async () => {
    for (const body of [
      { storageMode: 'cloud' },
      { storageMode: 'server', extra: true },
      { quotaBytes: -1 },
      { retentionDays: 0 },
      { retentionDays: 4000 },
      { keepVersions: 0 },
    ])
      expect((await call('PUT', '/settings', { body })).status).toBe(400)
    expect(
      (
        await call('PUT', '/settings', {
          body: Buffer.from('x'),
          type: 'text/plain',
        })
      ).status,
    ).toBe(400)
  })

  test('a switch keeps and reports where each earlier file is', async () => {
    const first = await put(gcode('one'), 'one.gcode', {
      query: useConnectorUpload,
    })
    expect(first.status).toBe(201)
    const switched = await useServerMode()
    expect(switched.status).toBe(200)
    expect((await switched.json()).locations).toEqual([
      { location: 'connector', agentId, files: 1, bytes: gcode('one').length },
    ])
    const second = await put(gcode('two'), 'two.gcode')
    expect(second.status).toBe(201)
    const report = await (await call('GET', '/settings')).json()
    expect(report.settings.storageMode).toBe('server')
    expect(report.locations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ location: 'connector', agentId, files: 1 }),
        expect.objectContaining({
          location: 'server',
          agentId: null,
          files: 1,
        }),
      ]),
    )
    const list = await (await call('GET', '', { as: 'viewer' })).json()
    expect(
      list.items
        .map((i: { latest: LibraryVersion }) => i.latest.storageLocation)
        .sort(),
    ).toEqual(['connector', 'server'])
    // Nothing moved: the earlier bytes are still on the Connector only.
    expect(connector.files.has(sha(gcode('one')))).toBe(true)
    expect(await files()).toEqual([sha(gcode('two'))])
  })
})

describe('upload in server mode', () => {
  beforeEach(async () => {
    await useServerMode()
  })

  test.each(['owner', 'admin', 'operator'])(
    '%s uploads and the file is parsed',
    async (who) => {
      const data = gcode(`by-${who}`, { model: 'Ender 3 V3', material: 'PETG' })
      const response = await put(data, 'Benchy.GCODE', {
        as: who,
        query: { tag: ['teste', 'pla'] },
      })
      expect(response.status).toBe(201)
      const body = await response.json<Uploaded>()
      expect(body.item).toMatchObject({
        title: 'Benchy',
        tags: ['teste', 'pla'],
      })
      expect(body.version).toMatchObject({
        versionNumber: 1,
        sha256: sha(data),
        sizeBytes: data.length,
        storageLocation: 'server',
        agentId: null,
        kind: 'gcode',
        uploadedBy: who,
        metadata: {
          slicer: 'OrcaSlicer',
          printerModel: 'Ender 3 V3',
          tools: [{ nozzleDiameter: 0.4, filamentType: 'PETG' }],
        },
      })
      expect(await files()).toContain(sha(data))
      expect(response.headers.get('cache-control')).toBe('no-store')
    },
  )

  test('a viewer is refused before the file is read or stored', async () => {
    const response = await put(gcode('v'), 'v.gcode', { as: 'viewer' })
    expect(response.status).toBe(403)
    expect(await files()).toEqual([])
    expect(store.calls).not.toContain('addVersion')
  })

  test('same bytes add a version without a second file; itemId adds a version', async () => {
    const data = gcode('same')
    const first = await (
      await put(data, 'a.gcode', { query: { title: 'Peça A' } })
    ).json<Uploaded>()
    const again = await (
      await put(data, 'a.gcode', { query: { itemId: first.item.id } })
    ).json<Uploaded>()
    expect(again.deduplicated).toBe(true)
    expect(again.version).toMatchObject({
      versionNumber: 2,
      itemId: first.item.id,
    })
    expect(await files()).toEqual([sha(data)])
    const newer = await (
      await put(gcode('newer'), 'a.gcode', { query: { itemId: first.item.id } })
    ).json<Uploaded>()
    expect(newer.version.versionNumber).toBe(3)
    const versions = await (
      await call('GET', `/items/${first.item.id}/versions`, { as: 'viewer' })
    ).json()
    expect(
      versions.versions.map((v: LibraryVersion) => v.versionNumber),
    ).toEqual([3, 2, 1])
  })

  test('3MF is parsed, with a thumbnail served separately', async () => {
    const response = await put(threeMf('p'), 'projeto.3mf')
    expect(response.status).toBe(201)
    const { version } = await response.json<Uploaded>()
    expect(version).toMatchObject({
      kind: '3mf',
      plateCount: 1,
      hasThumbnail: true,
      metadata: {
        slicer: 'Bambu Studio',
        printerModel: 'Bambu Lab X1',
        tools: [
          { nozzleDiameter: 0.4, filamentType: 'PETG', filamentGrams: 3 },
        ],
      },
    })
    expect(version.metadata.thumbnail).toBeUndefined()
  })

  test('refuses bad names, types, sizes and unparseable files, leaving nothing behind', async () => {
    expect((await put(gcode('x'), 'x.stl')).status).toBe(415)
    expect(
      (
        await call('POST', '', {
          body: gcode('x'),
          query: { name: 'x.gcode' },
          type: 'text/plain',
        })
      ).status,
    ).toBe(415)
    expect((await call('POST', '', { body: gcode('x') })).status).toBe(400)
    expect(
      (await put(gcode('x'), 'x.gcode', { query: { extra: '1' } })).status,
    ).toBe(400)
    expect(
      (await put(gcode('x'), 'x.gcode', { query: { itemId: 'nope' } })).status,
    ).toBe(400)
    const bad = await put(Buffer.from('not a zip'), 'bad.3mf')
    expect(bad.status).toBe(422)
    expect(await files()).toEqual([])
    expect(store.items).toHaveLength(0)
  })

  test('the 512 MiB cap is checked on the header and while streaming', async () => {
    const request = new Request(
      `https://farm.test/api/farms/${farmA}/library?name=big.gcode`,
      {
        method: 'POST',
        headers: {
          cookie: 'session=owner',
          origin,
          'content-type': 'application/octet-stream',
          'content-length': String(LIBRARY_MAX_UPLOAD_BYTES + 1),
        },
        body: 'x',
      },
    )
    expect((await handle(request, runtime)).status).toBe(413)
    const tooLarge: LibraryRuntime = {
      ...runtime,
      blobs: {
        read: blobs.read,
        remove: blobs.remove,
        put: async (source, options) => {
          expect(options?.maxBytes).toBe(LIBRARY_MAX_UPLOAD_BYTES)
          for await (const _chunk of source) break
          throw new BlobStoreError('too-large', 'too large')
        },
      },
    }
    await serve(tooLarge)
    expect((await put(gcode('x'), 'x.gcode')).status).toBe(413)
    expect(store.calls).not.toContain('addVersion')
  })

  test('quota and a mode change mid-upload refuse and discard the new file', async () => {
    await call('PUT', '/settings', { body: { quotaBytes: 10 } })
    const quota = await put(gcode('q'), 'q.gcode')
    expect(quota.status).toBe(507)
    expect((await quota.json()).message).toBe(
      'Cota da biblioteca excedida no servidor.',
    )
    await call('PUT', '/settings', { body: { quotaBytes: 1_000_000 } })
    store.beforeAdd = () =>
      store.settings.set(farmA, {
        ...store.settings.get(farmA)!,
        storageMode: 'connector',
      })
    const raced = await put(gcode('r'), 'r.gcode')
    expect(raced.status).toBe(409)
    expect(await files()).toEqual([])
    expect(store.items).toHaveLength(0)
  })

  test('without a server directory the upload is refused, not lost', async () => {
    await serve({ store: runtime.store })
    expect((await put(gcode('x'), 'x.gcode')).status).toBe(503)
  })

  test('a copy already on a Connector makes the new server file surplus', async () => {
    const data = gcode('on-connector')
    await call('PUT', '/settings', { body: { storageMode: 'connector' } })
    await put(data, 'c.gcode', { query: useConnectorUpload })
    await useServerMode()
    const again = await put(data, 'c.gcode')
    expect((await again.json<Uploaded>()).version.storageLocation).toBe(
      'connector',
    )
    expect(await files()).toEqual([])
  })
})

describe('upload in Connector mode', () => {
  test('relays the bytes and keeps none on the server', async () => {
    const data = gcode('relay')
    const response = await put(data, 'r.gcode', {
      as: 'operator',
      query: useConnectorUpload,
    })
    expect(response.status).toBe(201)
    const { version } = await response.json<Uploaded>()
    expect(version).toMatchObject({
      storageLocation: 'connector',
      agentId,
      sha256: sha(data),
    })
    expect(connector.files.get(sha(data))).toEqual(data)
    expect(await files()).toEqual([])
    const third = await put(threeMf('relay'), 'p.3mf', {
      query: useConnectorUpload,
    })
    expect((await third.json<Uploaded>()).version.metadata).toMatchObject({
      printerModel: 'Bambu Lab X1',
    })
    expect(await files()).toEqual([])
  })

  test('list, search and get still work from metadata while the Connector is down', async () => {
    const one = await (
      await put(gcode('a', { model: 'Voron 2.4' }), 'a.gcode', {
        query: useConnectorUpload,
      })
    ).json<Uploaded>()
    connector.down = true
    const list = await (
      await call('GET', '', { as: 'viewer', query: { printerModel: 'voron' } })
    ).json()
    expect(list.items.map((i: LibraryItem) => i.id)).toEqual([one.item.id])
    expect(
      (await call('GET', `/versions/${one.version.id}`, { as: 'viewer' }))
        .status,
    ).toBe(200)
  })

  test.each([
    ['viewer', 403],
    ['stranger', 404 - 404 + 403],
  ])('%s cannot upload', async (who, status) => {
    expect(
      (await put(gcode('x'), 'x.gcode', { as: who, query: useConnectorUpload }))
        .status,
    ).toBe(status)
    expect(connector.files.size).toBe(0)
  })

  test('needs an enrolled Connector and a reachable relay', async () => {
    expect((await put(gcode('x'), 'x.gcode')).status).toBe(400)
    expect(
      (
        await put(gcode('x'), 'x.gcode', {
          query: { agentId: '44444444-4444-4444-8444-444444444444' },
        })
      ).status,
    ).toBe(403)
    connector.down = true
    expect(
      (await put(gcode('x'), 'x.gcode', { query: useConnectorUpload })).status,
    ).toBe(503)
    await serve({ store: runtime.store, blobs })
    expect(
      (await put(gcode('x'), 'x.gcode', { query: useConnectorUpload })).status,
    ).toBe(503)
    expect(store.items).toHaveLength(0)
  })

  test('a new unparseable file is discarded from the Connector, a known one is kept', async () => {
    const known = gcode('known')
    await put(known, 'k.gcode', { query: useConnectorUpload })
    const bad = Buffer.from('broken 3mf')
    expect(
      (await put(bad, 'b.3mf', { query: useConnectorUpload })).status,
    ).toBe(422)
    expect(connector.discarded).toEqual([sha(bad)])
    expect(connector.files.has(sha(known))).toBe(true)
  })
})

describe('list and search', () => {
  async function seed() {
    const specs: [string, Buffer, string[]][] = [
      [
        'Benchy',
        gcode('1', { model: 'Ender 3', nozzle: 0.4, material: 'PLA' }),
        ['barco'],
      ],
      [
        'Suporte',
        gcode('2', {
          model: 'Voron 2.4',
          nozzle: 0.6,
          material: 'PETG',
          slicer: 'PrusaSlicer',
        }),
        ['util', 'barco'],
      ],
      [
        'Gancho',
        gcode('3', { model: 'Voron 2.4', nozzle: 0.4, material: 'PETG' }),
        ['util'],
      ],
      [
        'Caixa',
        gcode('4', {
          model: 'Ender 3',
          nozzle: 0.6,
          material: 'ABS',
          slicer: 'PrusaSlicer',
        }),
        [],
      ],
    ]
    for (const [title, data, tags] of specs)
      await put(data, `${title}.gcode`, {
        query: { title, tag: tags, ...useConnectorUpload },
      })
  }
  const titles = async (query: Record<string, string>, as = 'viewer') =>
    (
      (await (await call('GET', '', { as, query })).json())
        .items as LibraryItem[]
    ).map((i) => i.title)

  test('filters each field and combines them', async () => {
    await seed()
    expect(await titles({})).toEqual(['Caixa', 'Gancho', 'Suporte', 'Benchy'])
    expect(await titles({ title: 'anc' })).toEqual(['Gancho'])
    expect(await titles({ tag: 'BARCO' })).toEqual(['Suporte', 'Benchy'])
    expect(await titles({ printerModel: 'voron' })).toEqual([
      'Gancho',
      'Suporte',
    ])
    expect(await titles({ nozzle: '0.6' })).toEqual(['Caixa', 'Suporte'])
    expect(await titles({ material: 'petg' })).toEqual(['Gancho', 'Suporte'])
    expect(await titles({ slicer: 'prusa' })).toEqual(['Caixa', 'Suporte'])
    expect(
      await titles({
        printerModel: 'voron',
        material: 'PETG',
        nozzle: '0.4',
        tag: 'util',
      }),
    ).toEqual(['Gancho'])
    expect(await titles({ printerModel: 'voron', nozzle: '0.8' })).toEqual([])
  })

  test('pages are stable when items are inserted between requests', async () => {
    await seed()
    const first = await (
      await call('GET', '', { query: { limit: '2' } })
    ).json()
    expect(first.items.map((i: LibraryItem) => i.title)).toEqual([
      'Caixa',
      'Gancho',
    ])
    expect(first.nextCursor).toEqual(expect.any(String))
    await put(gcode('late-1'), 'Novo1.gcode', {
      query: { title: 'Novo 1', ...useConnectorUpload },
    })
    await put(gcode('late-2'), 'Novo2.gcode', {
      query: { title: 'Novo 2', ...useConnectorUpload },
    })
    const second = await (
      await call('GET', '', { query: { limit: '2', cursor: first.nextCursor } })
    ).json()
    expect(second.items.map((i: LibraryItem) => i.title)).toEqual([
      'Suporte',
      'Benchy',
    ])
    expect(second.nextCursor).toBeNull()
    const fresh = await titles({})
    expect(fresh.slice(0, 2)).toEqual(['Novo 2', 'Novo 1'])
  })

  test('a filtered walk visits every match once', async () => {
    await seed()
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: { items: LibraryItem[]; nextCursor: string | null } = await (
        await call('GET', '', {
          query: {
            material: 'petg',
            limit: '1',
            ...(cursor ? { cursor } : {}),
          },
        })
      ).json()
      seen.push(...page.items.map((i) => i.title))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual(['Gancho', 'Suporte'])
  })

  test('rejects bad paging and unknown filters', async () => {
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { cursor: '!!' },
      { cursor: Buffer.from('[1,"x"]').toString('base64url') },
      { nozzle: '-1' },
      { color: 'red' },
    ])
      expect((await call('GET', '', { query })).status).toBe(400)
  })

  test('an item whose versions are all deleted disappears', async () => {
    await seed()
    const list = await (
      await call('GET', '', { query: { title: 'Caixa' } })
    ).json()
    await call('DELETE', `/versions/${list.items[0].latest.id}`)
    expect(await titles({ title: 'Caixa' })).toEqual([])
  })
})

describe('get, thumbnail and delete', () => {
  let uploaded: Uploaded
  beforeEach(async () => {
    uploaded = await (
      await put(threeMf('t'), 'p.3mf', { query: useConnectorUpload })
    ).json<Uploaded>()
  })

  test('any member reads a version with its metadata', async () => {
    for (const who of ['owner', 'admin', 'operator', 'viewer']) {
      const response = await call('GET', `/versions/${uploaded.version.id}`, {
        as: who,
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.version).toMatchObject({
        id: uploaded.version.id,
        storageLocation: 'connector',
        agentId,
      })
      expect(body.version.metadata.thumbnail).toBeUndefined()
      expect(body.item.title).toBe('p')
    }
  })

  test('looks up a version for replay by SHA-256', async () => {
    const found = await call(
      'GET',
      `/replay-source?sha256=${uploaded.version.sha256}`,
      { as: 'viewer' },
    )
    expect(found.status).toBe(200)
    expect(await found.json()).toMatchObject({
      version: { id: uploaded.version.id, sha256: uploaded.version.sha256 },
    })
    expect(
      (await call('GET', `/replay-source?sha256=${'b'.repeat(64)}`)).status,
    ).toBe(404)
    expect((await call('GET', '/replay-source?sha256=zz')).status).toBe(400)
  })

  test('thumbnail carries content type and cache headers, and revalidates', async () => {
    const response = await call(
      'GET',
      `/versions/${uploaded.version.id}/thumbnail`,
      { as: 'viewer' },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe(
      'private, max-age=31536000, immutable',
    )
    expect(response.headers.get('etag')).toBe(`"${uploaded.version.sha256}"`)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.bytes()).toEqual(PNG)
    const cached = await call(
      'GET',
      `/versions/${uploaded.version.id}/thumbnail`,
      {
        as: 'viewer',
        headers: { 'if-none-match': `"${uploaded.version.sha256}"` },
      },
    )
    expect(cached.status).toBe(304)
  })

  test('a version without a thumbnail answers 404 there', async () => {
    const plain = await (
      await put(gcode('plain'), 'g.gcode', { query: useConnectorUpload })
    ).json<Uploaded>()
    expect(
      (await call('GET', `/versions/${plain.version.id}/thumbnail`)).status,
    ).toBe(404)
  })

  test.each([
    ['owner', 200],
    ['admin', 200],
    ['operator', 403],
    ['viewer', 403],
  ])('%s deleting answers %i', async (who, status) => {
    const response = await call('DELETE', `/versions/${uploaded.version.id}`, {
      as: who,
    })
    expect(response.status).toBe(status)
    const read = await call('GET', `/versions/${uploaded.version.id}`)
    expect(read.status).toBe(status === 200 ? 404 : 200)
    if (status === 200) {
      expect(await response.json()).toMatchObject({ deleted: true })
      expect(
        (await call('DELETE', `/versions/${uploaded.version.id}`)).status,
      ).toBe(404)
    }
  })

  test('malformed or unknown ids are refused', async () => {
    expect((await call('GET', '/versions/not-a-uuid')).status).toBe(400)
    expect((await call('GET', `/versions/${randomUUID()}`)).status).toBe(404)
    expect((await call('DELETE', `/versions/${randomUUID()}`)).status).toBe(404)
    expect((await call('GET', '/items/nope/versions')).status).toBe(400)
  })
})

describe('farm boundary and session', () => {
  test('another farm is refused on every route and leaks nothing', async () => {
    const mine = await (
      await put(threeMf('mine'), 'segredo.3mf', {
        query: { title: 'Segredo', ...useConnectorUpload },
      })
    ).json<Uploaded>()
    const v = mine.version.id
    const reads: [string, string][] = [
      ['GET', ''],
      ['GET', '/settings'],
      ['GET', `/versions/${v}`],
      ['GET', `/versions/${v}/thumbnail`],
      ['GET', `/items/${mine.item.id}/versions`],
    ]
    for (const [method, path] of reads) {
      const response = await call(method, path, { as: 'outsider', farm: farmA })
      expect(response.status, `${method} ${path}`).toBe(404)
      expect(JSON.stringify(await response.json())).not.toContain('Segredo')
    }
    const writes: [string, string, Call][] = [
      [
        'POST',
        '',
        { body: gcode('x'), query: { name: 'x.gcode', ...useConnectorUpload } },
      ],
      ['PUT', '/settings', { body: { storageMode: 'server' } }],
      ['DELETE', `/versions/${v}`, {}],
    ]
    for (const [method, path, extra] of writes)
      expect(
        (await call(method, path, { ...extra, as: 'outsider', farm: farmA }))
          .status,
        `${method} ${path}`,
      ).toBe(403)
    expect(store.settings.get(farmA)).toBeUndefined()
    expect(store.versions.every((x) => x.deletedAt === null)).toBe(true)
    expect(store.items).toHaveLength(1)
  })

  test('ids from another farm do not resolve, even for a member of both', async () => {
    roles['dual'] = { [farmA]: 'owner', [farmB]: 'owner' }
    const mine = await (
      await put(gcode('dual'), 'd.gcode', {
        as: 'dual',
        query: useConnectorUpload,
      })
    ).json<Uploaded>()
    expect(
      (
        await call('GET', `/versions/${mine.version.id}`, {
          as: 'dual',
          farm: farmB,
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await call('DELETE', `/versions/${mine.version.id}`, {
          as: 'dual',
          farm: farmB,
        })
      ).status,
    ).toBe(404)
    expect((await call('GET', '', { as: 'dual', farm: farmB })).status).toBe(
      200,
    )
    expect(
      (await (await call('GET', '', { as: 'dual', farm: farmB })).json()).items,
    ).toEqual([])
  })

  test('requires a session, a valid farm id, the right method and a trusted origin', async () => {
    expect((await call('GET', '', { as: null })).status).toBe(401)
    expect((await call('GET', '', { farm: 'not-a-uuid' })).status).toBe(400)
    expect((await call('PATCH', '/settings', { body: {} })).status).toBe(405)
    const noOrigin = await fetch(
      new URL(`/api/farms/${farmA}/library/settings`, server!.url),
      {
        method: 'PUT',
        headers: {
          cookie: 'session=owner',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ storageMode: 'server' }),
      },
    )
    expect(noOrigin.status).toBe(403)
    expect(store.settings.size).toBe(0)
  })
})
