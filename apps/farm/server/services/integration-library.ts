import { createHash, randomUUID } from 'node:crypto'
import type { IntegrationPrincipal } from '../utils/integration-auth.ts'
import { uuidPattern } from '../utils/integration-auth.ts'
import { ingest, type RangeSource } from '../utils/library/ingest.ts'
import type { StorageMode } from '../utils/library/quota.ts'

export type { StorageMode }

const NAME = /^[^\\/\x00-\x1f\x7f]{1,255}$/
const MAX_PAGE = 100

export interface LibraryVersionView {
  id: string
  itemId: string
  versionNumber: number
  sha256: string
  sizeBytes: number
  storageLocation: StorageMode
  originalName: string
  kind: 'gcode' | '3mf'
  plateCount: number
  createdAt: number
}
export interface LibraryItemView {
  id: string
  farmId: string
  title: string
  storageMode: StorageMode
  latest: LibraryVersionView
}
export interface ResolvedLibraryVersion {
  id: string
  farmId: string
  sha256: string
  sizeBytes: number
  displayName: string
  storageMode: StorageMode
  plateCount: number
}
export interface LibraryAudit {
  farmId: string
  appId: string
  action: 'library.changed'
  resourceType: 'library'
  resourceId: string
  outcome: 'created' | 'accepted' | 'held'
  details: Record<string, string | number | boolean | null>
}
export interface LibraryVersionEvent {
  type: 'library.version.created'
  farmId: string
  itemId: string
  versionId: string
  storageMode: StorageMode
  sha256: string
}
export type LibraryProblem =
  | 'invalid-request'
  | 'not-found'
  | 'validation-failed'
  | 'payload-too-large'
  | 'unsupported-media-type'
  | 'service-unavailable'
  | 'insufficient-scope'

export type LibraryResult<T> =
  { ok: true; value: T } | { ok: false; problem: LibraryProblem }

export interface NewLibraryVersion {
  farmId: string
  title: string
  originalName: string
  kind: 'gcode' | '3mf'
  sha256: string
  sizeBytes: number
  plateCount: number
  storageLocation: StorageMode
  agentId: string | null
  createdAt: number
  id: string
  itemId: string
  versionNumber: number
}

export interface IntegrationLibraryStore {
  getMode(farmId: string): Promise<StorageMode>
  setMode(farmId: string, mode: StorageMode, now: number): Promise<void>
  list(
    farmId: string,
    after: { createdAt: number; id: string } | null,
    limit: number,
  ): Promise<LibraryItemView[]>
  getItem(itemId: string): Promise<LibraryItemView | null>
  version(versionId: string): Promise<ResolvedLibraryVersion | null>
  /** Where a connector-mode upload is stored. Null when the farm has no Connector. */
  agentFor(farmId: string): Promise<string | null>
  /** Server mode keeps the bytes. Connector mode keeps none. */
  retain(sha256: string, bytes: Uint8Array, mode: StorageMode): Promise<void>
  addVersion(version: NewLibraryVersion): Promise<LibraryItemView>
  insertAudit(entry: LibraryAudit, now: number): Promise<void>
}

export interface LibraryPage {
  data: LibraryItemView[]
  nextCursor: string | null
  storageMode: StorageMode
}
export interface LibrarySettingsView {
  farmId: string
  storageMode: StorageMode
}
export interface LibraryUploadView {
  item: Omit<LibraryItemView, 'latest'>
  version: LibraryVersionView
  storageMode: StorageMode
  deduplicated: boolean
}

const fail = (problem: LibraryProblem): LibraryResult<never> => ({
  ok: false,
  problem,
})

function farmWide(
  principal: IntegrationPrincipal,
  scope: 'library:read' | 'library:write',
  farmId: string,
) {
  return principal.grants.some(
    (grant) =>
      grant.farmId === farmId &&
      grant.printerAssignmentId === null &&
      grant.scopes.includes(scope),
  )
}

export function encodeLibraryCursor(createdAt: number, id: string) {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url')
}

export function decodeLibraryCursor(
  cursor: string | null,
): { createdAt: number; id: string } | null | undefined {
  if (cursor === null) return undefined
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) return null
  try {
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) return null
    const value: unknown = JSON.parse(bytes.toString())
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !Number.isSafeInteger(value[0]) ||
      Number(value[0]) < 0 ||
      typeof value[1] !== 'string' ||
      !uuidPattern.test(value[1])
    )
      return null
    return { createdAt: value[0], id: value[1] }
  } catch {
    return null
  }
}

function kindOf(name: string): 'gcode' | '3mf' | undefined {
  const ext = /\.(gcode|3mf)$/i.exec(name)?.[1]?.toLowerCase()
  return ext === 'gcode' || ext === '3mf' ? ext : undefined
}

function sourceOf(bytes: Uint8Array): RangeSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      if (length <= 0 || offset >= bytes.length) return new Uint8Array()
      return bytes.subarray(offset, Math.min(bytes.length, offset + length))
    },
  }
}

function itemOf(row: LibraryItemView): LibraryItemView {
  return {
    id: row.id,
    farmId: row.farmId,
    title: row.title,
    storageMode: row.storageMode,
    latest: row.latest,
  }
}

/**
 * Farm library for integration apps. Reads return the farm's storage mode.
 * Uploads are stored in that mode: server keeps the bytes, connector keeps
 * only the hash and metadata. Nothing here is tied to one consumer app.
 */
export class IntegrationLibraryService {
  readonly audits: LibraryAudit[] = []
  readonly events: LibraryVersionEvent[] = []
  private readonly store: IntegrationLibraryStore
  private readonly now: () => number
  constructor(store: IntegrationLibraryStore, now: () => number = Date.now) {
    this.store = store
    this.now = now
  }

  async list(
    principal: IntegrationPrincipal,
    farmId: string,
    cursor: string | null,
    limit: number,
  ): Promise<LibraryResult<LibraryPage>> {
    if (!principal.scopes.includes('library:read'))
      return fail('insufficient-scope')
    if (
      !uuidPattern.test(farmId) ||
      !farmWide(principal, 'library:read', farmId)
    )
      return fail('not-found')
    const after = decodeLibraryCursor(cursor)
    if (after === null || limit < 1 || limit > MAX_PAGE)
      return fail('invalid-request')
    try {
      const storageMode = await this.store.getMode(farmId)
      const rows = await this.store.list(farmId, after ?? null, limit + 1)
      const page = rows.slice(0, limit).map(itemOf)
      const last = page.at(-1)
      return {
        ok: true,
        value: {
          data: page,
          storageMode,
          nextCursor:
            rows.length > limit && last
              ? encodeLibraryCursor(last.latest.createdAt, last.id)
              : null,
        },
      }
    } catch {
      return fail('service-unavailable')
    }
  }

  async get(
    principal: IntegrationPrincipal,
    itemId: string,
  ): Promise<LibraryResult<LibraryItemView>> {
    if (!principal.scopes.includes('library:read'))
      return fail('insufficient-scope')
    if (!uuidPattern.test(itemId)) return fail('invalid-request')
    try {
      const item = await this.store.getItem(itemId)
      if (!item || !farmWide(principal, 'library:read', item.farmId))
        return fail('not-found')
      return { ok: true, value: itemOf(item) }
    } catch {
      return fail('service-unavailable')
    }
  }

  async settings(
    principal: IntegrationPrincipal,
    farmId: string,
  ): Promise<LibraryResult<LibrarySettingsView>> {
    if (!principal.scopes.includes('library:read'))
      return fail('insufficient-scope')
    if (
      !uuidPattern.test(farmId) ||
      !farmWide(principal, 'library:read', farmId)
    )
      return fail('not-found')
    try {
      return {
        ok: true,
        value: { farmId, storageMode: await this.store.getMode(farmId) },
      }
    } catch {
      return fail('service-unavailable')
    }
  }

  async setSettings(
    principal: IntegrationPrincipal,
    farmId: string,
    storageMode: unknown,
  ): Promise<LibraryResult<LibrarySettingsView>> {
    if (!principal.scopes.includes('library:write'))
      return fail('insufficient-scope')
    if (
      !uuidPattern.test(farmId) ||
      !farmWide(principal, 'library:write', farmId)
    )
      return fail('not-found')
    if (storageMode !== 'server' && storageMode !== 'connector')
      return fail('validation-failed')
    try {
      const now = this.now()
      await this.store.setMode(farmId, storageMode, now)
      await this.audit(principal, farmId, farmId, 'accepted', {
        storageMode,
        status: 'settings',
      })
      return { ok: true, value: { farmId, storageMode } }
    } catch {
      return fail('service-unavailable')
    }
  }

  async upload(
    principal: IntegrationPrincipal,
    input: { farmId: string; name: string; bytes: Uint8Array },
    maxBytes: number,
  ): Promise<LibraryResult<LibraryUploadView>> {
    if (!principal.scopes.includes('library:write'))
      return fail('insufficient-scope')
    if (
      !uuidPattern.test(input.farmId) ||
      !farmWide(principal, 'library:write', input.farmId)
    )
      return fail('not-found')
    if (!NAME.test(input.name)) return fail('invalid-request')
    const kind = kindOf(input.name)
    if (!kind) return fail('unsupported-media-type')
    if (input.bytes.length < 1) return fail('invalid-request')
    if (input.bytes.length > maxBytes) return fail('payload-too-large')
    try {
      const mode = await this.store.getMode(input.farmId)
      const agentId =
        mode === 'connector' ? await this.store.agentFor(input.farmId) : null
      if (mode === 'connector' && !agentId) return fail('service-unavailable')
      const parsed = await ingest(kind, sourceOf(input.bytes))
      if (!parsed.ok) return fail('validation-failed')
      const sha256 = createHash('sha256').update(input.bytes).digest('hex')
      await this.store.retain(sha256, input.bytes, mode)
      const now = this.now()
      const existing = (
        await this.store.list(input.farmId, null, MAX_PAGE)
      ).find(
        (item) =>
          item.latest.sha256 === sha256 && item.latest.storageLocation === mode,
      )
      const saved =
        existing ??
        (await this.store.addVersion({
          id: randomUUID(),
          itemId: randomUUID(),
          farmId: input.farmId,
          title: input.name.replace(/\.(gcode|3mf)$/i, '').trim() || input.name,
          originalName: input.name,
          kind,
          sha256,
          sizeBytes: input.bytes.length,
          plateCount: parsed.plateCount,
          storageLocation: mode,
          agentId,
          createdAt: now,
          versionNumber: 1,
        }))
      if (!existing) {
        this.events.push({
          type: 'library.version.created',
          farmId: input.farmId,
          itemId: saved.id,
          versionId: saved.latest.id,
          storageMode: mode,
          sha256,
        })
        await this.audit(principal, input.farmId, saved.latest.id, 'created', {
          storageMode: mode,
          status: 'library.version.created',
        })
      }
      const { latest, ...item } = saved
      return {
        ok: true,
        value: {
          item,
          version: latest,
          storageMode: mode,
          deduplicated: existing !== undefined,
        },
      }
    } catch {
      return fail('service-unavailable')
    }
  }

  async version(versionId: string): Promise<ResolvedLibraryVersion | null> {
    if (!uuidPattern.test(versionId)) return null
    return this.store.version(versionId)
  }

  async recordReplay(entry: {
    farmId: string
    appId: string
    printerId: string
    versionId: string
    storageMode: StorageMode
    plate?: number
    outcome: 'accepted' | 'held'
  }) {
    await this.audit(
      { appId: entry.appId },
      entry.farmId,
      entry.versionId,
      entry.outcome,
      {
        storageMode: entry.storageMode,
        status: 'replay',
        ...(entry.plate === undefined ? {} : { count: entry.plate }),
      },
    )
  }

  private async audit(
    principal: { appId: string },
    farmId: string,
    resourceId: string,
    outcome: LibraryAudit['outcome'],
    details: LibraryAudit['details'],
  ) {
    const entry: LibraryAudit = {
      farmId,
      appId: principal.appId,
      action: 'library.changed',
      resourceType: 'library',
      resourceId,
      outcome,
      details,
    }
    this.audits.push(entry)
    await this.store.insertAudit(entry, this.now())
  }
}

interface MemoryRow extends NewLibraryVersion {
  title: string
}

/** In-process library. Server mode keeps the bytes; connector mode keeps none. */
export class MemoryLibraryStore implements IntegrationLibraryStore {
  readonly modes = new Map<string, StorageMode>()
  readonly agents = new Map<string, string>()
  readonly bytes = new Map<string, Uint8Array>()
  private readonly rows: MemoryRow[] = []

  async getMode(farmId: string) {
    return this.modes.get(farmId) ?? 'connector'
  }
  async setMode(farmId: string, mode: StorageMode) {
    this.modes.set(farmId, mode)
  }
  async agentFor(farmId: string) {
    return this.agents.get(farmId) ?? null
  }
  private view(row: MemoryRow, mode: StorageMode): LibraryItemView {
    return {
      id: row.itemId,
      farmId: row.farmId,
      title: row.title,
      storageMode: mode,
      latest: {
        id: row.id,
        itemId: row.itemId,
        versionNumber: row.versionNumber,
        sha256: row.sha256,
        sizeBytes: row.sizeBytes,
        storageLocation: row.storageLocation,
        originalName: row.originalName,
        kind: row.kind,
        plateCount: row.plateCount,
        createdAt: row.createdAt,
      },
    }
  }
  async list(
    farmId: string,
    after: { createdAt: number; id: string } | null,
    limit: number,
  ) {
    const mode = await this.getMode(farmId)
    return this.rows
      .filter((row) => row.farmId === farmId)
      .sort(
        (a, b) => b.createdAt - a.createdAt || b.itemId.localeCompare(a.itemId),
      )
      .filter(
        (row) =>
          !after ||
          row.createdAt < after.createdAt ||
          (row.createdAt === after.createdAt && row.itemId < after.id),
      )
      .slice(0, limit)
      .map((row) => this.view(row, mode))
  }
  async getItem(itemId: string) {
    const row = this.rows.find((entry) => entry.itemId === itemId)
    if (!row) return null
    return this.view(row, await this.getMode(row.farmId))
  }
  async version(versionId: string) {
    const row = this.rows.find((entry) => entry.id === versionId)
    if (!row) return null
    return {
      id: row.id,
      farmId: row.farmId,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      displayName: row.originalName,
      storageMode: row.storageLocation,
      plateCount: row.plateCount,
    }
  }
  async retain(sha256: string, bytes: Uint8Array, mode: StorageMode) {
    if (mode === 'server') this.bytes.set(sha256, bytes)
    else this.bytes.delete(sha256)
  }
  async addVersion(version: NewLibraryVersion) {
    this.rows.push(version)
    if (version.storageLocation === 'connector')
      this.bytes.delete(version.sha256)
    return this.view(version, await this.getMode(version.farmId))
  }
  async insertAudit() {}

  /** Test seed. `bytes` are kept only in server mode. */
  seed(version: NewLibraryVersion, bytes?: Uint8Array) {
    this.rows.push(version)
    if (bytes && version.storageLocation === 'server')
      this.bytes.set(version.sha256, bytes)
  }
}

export function libraryJobFileUrl(versionId: string) {
  return `https://library.openfarm.dev/versions/${versionId}`
}
