import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Sql } from 'postgres'
import { describe, expect, test } from 'vitest'
import type { PrintFileMetadata } from '../../packages/shared/src/print-file/metadata.ts'
import { createBlobStore } from '../../apps/farm/server/utils/library/blob-store.ts'
import {
  isPurgeable,
  runLibraryRetention,
  type BlobFacts,
} from '../../apps/farm/server/utils/library/retention.ts'
import { PostgresLibrary } from '../../apps/farm/server/utils/library/store.ts'

const DAY = 86_400_000
const NOW = 1_900_000_000_000
const FARM_A = '11111111-1111-4111-8111-111111111111'
const FARM_B = '22222222-2222-4222-8222-222222222222'
const SESSION = 'sess-race'
const FRAGMENT = Symbol('fragment')
const JSON_VAL = Symbol('json')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

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

type Blob = {
  farmId: string
  sha256: string
  sizeBytes: number
  location: 'server' | 'connector'
  agentId: string | null
  createdAt: number
  purgedAt: number | null
}
type Version = {
  id: string
  farmId: string
  itemId: string
  versionNumber: number
  sha256: string
  sizeBytes: number
  storageLocation: 'server' | 'connector'
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
type Item = {
  id: string
  farmId: string
  title: string
  tags: string[]
  archived: boolean
  createdAt: number
}

type State = {
  blobs: Blob[]
  versions: Version[]
  items: Item[]
  retentionDays: Record<string, number>
  pauseAfterBlobLock?: (() => Promise<void>) | undefined
}

function factsFor(state: State, blob: Blob): BlobFacts {
  const refs = state.versions.filter(
    (v) => v.farmId === blob.farmId && v.sha256 === blob.sha256,
  )
  const deleted = refs.map((v) => v.deletedAt).filter((d) => d !== null)
  return {
    farmId: blob.farmId,
    sha256: blob.sha256,
    sizeBytes: blob.sizeBytes,
    location: blob.location,
    agentId: blob.agentId,
    createdAt: blob.createdAt,
    retentionDays: state.retentionDays[blob.farmId] ?? 30,
    refs: refs.length,
    live: refs.some((v) => v.deletedAt === null),
    newestDeletedAt: deleted.length ? Math.max(...deleted) : null,
  }
}

/** Mutual exclusion for `library-blob:` advisory locks across concurrent transactions. */
function createBlobLockQueue() {
  let holder: symbol | null = null
  const waiters: (() => void)[] = []
  return {
    async acquire(txId: symbol) {
      while (holder && holder !== txId) {
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
      holder = txId
    },
    release(txId: symbol) {
      if (holder === txId) {
        holder = null
        waiters.shift()?.()
      }
    },
  }
}

function createRaceSql(state: State): Sql {
  const blobLocks = createBlobLockQueue()
  let txDepth = 0
  let txId: symbol | null = null

  const joinVersion = (v: Version) => {
    const blob = state.blobs.find(
      (b) =>
        b.farmId === v.farmId &&
        b.sha256 === v.sha256 &&
        b.location === v.storageLocation &&
        (b.agentId ?? null) === (v.agentId ?? null),
    )
    return {
      id: v.id,
      itemId: v.itemId,
      versionNumber: v.versionNumber,
      sha256: v.sha256,
      sizeBytes: v.sizeBytes,
      storageLocation: v.storageLocation,
      agentId: v.agentId,
      originalName: v.originalName,
      kind: v.kind,
      plateCount: v.plateCount,
      metadata: v.metadata,
      hasThumbnail: Boolean(v.metadata.thumbnail),
      notes: v.notes,
      uploadedBy: v.uploadedBy,
      createdAt: v.createdAt,
      deletedAt: v.deletedAt,
      purgedAt: blob?.purgedAt ?? null,
    }
  }

  const execute = async (text: string, params: unknown[]) => {
    if (text.startsWith('SET LOCAL')) return []
    if (text.includes('pg_advisory_xact_lock')) {
      const key = String(params[0] ?? '')
      if (key.startsWith('library-blob:') && txId) {
        await blobLocks.acquire(txId)
        if (state.pauseAfterBlobLock) {
          const pause = state.pauseAfterBlobLock
          state.pauseAfterBlobLock = undefined
          await pause()
        }
      }
      return []
    }
    if (text.includes('FROM farm.session_accounts'))
      return [{ id: 'acc', sessionVersion: 0, disabled: false }]
    if (text.includes('FROM farm.account_sessions'))
      return [
        {
          id: SESSION,
          accountId: 'acc',
          accountVersion: 0,
          createdAt: NOW,
          lastSeenAt: NOW,
          absoluteExpiresAt: NOW + 86_400_000,
          revokedAt: null,
        },
      ]
    if (text.startsWith('UPDATE farm.account_sessions')) return []
    if (text.includes('FROM farm.memberships'))
      return [{ role: 'owner', revoked_at: null }]
    if (text.includes('FROM farm.library_settings'))
      return [
        {
          storageMode: 'server',
          quotaBytes: 20 * 1024 ** 3,
          retentionDays: 30,
          keepVersions: null,
        },
      ]
    if (text.includes('SELECT storage_location AS "storageLocation"')) return []
    if (text.includes('COALESCE(sum(size_bytes), 0)')) return [{ used: 0 }]
    if (text.startsWith('INSERT INTO farm.library_blobs')) {
      const [farmId, hash, sizeBytes] = params as [string, string, number]
      state.blobs.push({
        farmId,
        sha256: hash,
        sizeBytes,
        location: 'server',
        agentId: null,
        createdAt: NOW,
        purgedAt: null,
      })
      return []
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
      state.items.push({
        id,
        farmId,
        title,
        tags,
        archived: false,
        createdAt,
      })
      return [
        { id, title, tags, archived: false, createdAt: createdAt as number },
      ]
    }
    if (text.includes('COALESCE(max(version_number), 0)::int + 1'))
      return [{ n: 1 }]
    if (text.startsWith('INSERT INTO farm.library_versions')) {
      const [
        id,
        farmId,
        itemId,
        versionNumber,
        hash,
        sizeBytes,
        ,
        ,
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
        string,
        null,
        string,
        'gcode' | '3mf',
        number,
        PrintFileMetadata,
        string,
        string,
        number,
      ]
      state.versions.push({
        id,
        farmId,
        itemId,
        versionNumber,
        sha256: hash,
        sizeBytes,
        storageLocation: 'server',
        agentId: null,
        originalName,
        kind,
        plateCount,
        metadata,
        notes,
        uploadedBy,
        createdAt,
        deletedAt: null,
      })
      return []
    }
    if (text.includes('FROM farm.library_versions v JOIN farm.library_blobs b'))
      return [joinVersion(state.versions.at(-1)!)]
    if (text.startsWith('SELECT b.farm_id') || text.includes('GROUP BY'))
      return [{ fragment: true }]
    if (text.startsWith('UPDATE farm.library_versions')) return []
    if (text.includes('HAVING')) {
      return state.blobs
        .filter((b) => b.purgedAt === null)
        .map((b) => factsFor(state, b))
        .filter((f) => isPurgeable(f, NOW, 3_600_000))
    }
    if (text.includes('b.sha256=')) {
      const [, farmId, hash] = params as [unknown, string, string]
      return state.blobs
        .filter(
          (b) =>
            b.farmId === farmId && b.sha256 === hash && b.purgedAt === null,
        )
        .map((b) => factsFor(state, b))
    }
    if (text.startsWith('UPDATE farm.library_blobs SET purged_at')) {
      const [now, farmId, hash] = params as [number, string, string]
      const blob = state.blobs.find(
        (b) => b.farmId === farmId && b.sha256 === hash && b.purgedAt === null,
      )
      if (!blob) return []
      blob.purgedAt = now
      return [{ '?column?': 1 }]
    }
    if (text.startsWith('SELECT 1 FROM farm.library_blobs WHERE sha256=')) {
      const hit = state.blobs.some(
        (b) =>
          b.sha256 === params[0] &&
          b.location === 'server' &&
          b.purgedAt === null,
      )
      return hit ? [{}] : []
    }
    if (text.startsWith('SELECT DISTINCT sha256')) return []
    throw new Error(`unexpected statement: ${text}`)
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
    begin: async <T>(work: (tx: typeof query) => Promise<T>) => {
      const id = Symbol('tx')
      const outer = txId
      const depth = txDepth
      txId = id
      txDepth++
      try {
        return await work(sql)
      } finally {
        txDepth--
        if (txDepth === 0) blobLocks.release(id)
        txId = outer
      }
    },
  })
  return sql as unknown as Sql
}

describe('library blob purge race (#607)', () => {
  test('cross-farm dedup upload keeps the shared server file when purge runs concurrently', async () => {
    const content = 'shared-bytes'
    const hash = sha(content)
    const state: State = {
      blobs: [
        {
          farmId: FARM_A,
          sha256: hash,
          sizeBytes: content.length,
          location: 'server',
          agentId: null,
          createdAt: NOW - 90 * DAY,
          purgedAt: null,
        },
      ],
      versions: [
        {
          id: 'v-a',
          farmId: FARM_A,
          itemId: 'item-a',
          versionNumber: 1,
          sha256: hash,
          sizeBytes: content.length,
          storageLocation: 'server',
          agentId: null,
          originalName: 'a.gcode',
          kind: 'gcode',
          plateCount: 1,
          metadata: {},
          notes: '',
          uploadedBy: 'acc',
          createdAt: NOW - 90 * DAY,
          deletedAt: NOW - 40 * DAY,
        },
      ],
      items: [],
      retentionDays: { [FARM_A]: 30, [FARM_B]: 30 },
    }
    const dir = await mkdtemp(join(tmpdir(), 'openfarm-blob-race-'))
    const blobs = await createBlobStore(dir)
    await blobs.put(
      (async function* () {
        yield Buffer.from(content)
      })(),
    )
    const sql = createRaceSql(state)
    const store = new PostgresLibrary(sql, () => NOW)
    let retentionDone!: Promise<void>
    state.pauseAfterBlobLock = async () => {
      retentionDone = runLibraryRetention(
        { sql, blobs, clock: () => NOW },
        { batchSize: 50 },
      ).then(() => undefined)
    }
    const upload = store.addVersion({
      sessionRecordId: SESSION,
      policy: { idleTimeoutMs: 60_000 },
      farmId: FARM_B,
      version: {
        title: 'B title',
        sha256: hash,
        sizeBytes: content.length,
        location: 'server',
        originalName: 'b.gcode',
        kind: 'gcode',
        plateCount: 1,
        metadata: {},
      },
    })
    const [added] = await Promise.all([upload, retentionDone!])
    expect(added.ok).toBe(true)
    if (!added.ok) throw new Error('upload failed')
    expect(
      state.blobs.some(
        (b) => b.farmId === FARM_B && b.sha256 === hash && b.purgedAt === null,
      ),
    ).toBe(true)
    expect((await blobs.list()).some((f) => f.sha256 === hash)).toBe(true)
  })
})
