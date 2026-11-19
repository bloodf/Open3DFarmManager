import { mkdtemp, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { Sql } from 'postgres'
import { createBlobStore } from '../../apps/farm/server/utils/library/blob-store.ts'
import {
  checkQuota,
  DEFAULT_QUOTA_BYTES,
  defaultQuotaBytes,
  describeUsage,
  quotaBasis,
  recordConnectorStorage,
  summarizeUsage,
} from '../../apps/farm/server/utils/library/quota.ts'
import {
  isPurgeable,
  parseLibraryRetentionConfig,
  PURGED_LABEL,
  replayAvailability,
  runLibraryRetention,
  type BlobFacts,
  type ConnectorLibraryPort,
} from '../../apps/farm/server/utils/library/retention.ts'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const FARM = '11111111-1111-4111-8111-111111111111'
const FARM2 = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

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
  createdAt: number
  deletedAt: number | null
}
type State = {
  blobs: Blob[]
  versions: Version[]
  keepVersions: Record<string, number>
  retentionDays: Record<string, number>
  /** Test seam: runs once the purge transaction holds the farm lock. */
  afterLock?: ((state: State) => void) | undefined
  /** Return every unpurged blob as a candidate, like a prefilter that is stale. */
  staleCandidates?: boolean | undefined
}

const clone = <T>(value: T): T => structuredClone(value)

/** Minimal in-memory stand-in for the statements the retention job issues. */
function fakeSql(state: State): Sql {
  const factsFor = (blob: Blob): BlobFacts => {
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
  const marker = { fragment: true }
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim()
    if (text.startsWith('SELECT b.farm_id') || text.startsWith('GROUP BY'))
      return marker
    if (text.startsWith('SET LOCAL')) return []
    if (text.includes('pg_advisory_xact_lock')) {
      state.afterLock?.(state)
      return []
    }
    if (text.startsWith('UPDATE farm.library_versions')) {
      const now = values[0] as number
      const trimmed: Version[] = []
      for (const old of state.versions) {
        const keep = state.keepVersions[old.farmId]
        if (keep === undefined || old.deletedAt !== null) continue
        const newer = state.versions.filter(
          (v) =>
            v.itemId === old.itemId &&
            v.deletedAt === null &&
            v.versionNumber > old.versionNumber,
        )
        if (newer.length >= keep) trimmed.push(old)
      }
      for (const version of trimmed) version.deletedAt = now
      return trimmed.map((v) => ({ id: v.id }))
    }
    if (text.includes('HAVING')) {
      const unpurged = state.blobs.filter((b) => b.purgedAt === null)
      const all = unpurged.map(factsFor)
      return state.staleCandidates
        ? all
        : all.filter((f) => isPurgeable(f, NOW, 3_600_000))
    }
    if (text.includes('b.sha256=')) {
      const [, farmId, sha256] = values as [unknown, string, string]
      return state.blobs
        .filter(
          (b) =>
            b.farmId === farmId && b.sha256 === sha256 && b.purgedAt === null,
        )
        .map(factsFor)
    }
    if (text.startsWith('UPDATE farm.library_blobs SET purged_at')) {
      const [now, farmId, sha256] = values as [number, string, string]
      const blob = state.blobs.find(
        (b) =>
          b.farmId === farmId && b.sha256 === sha256 && b.purgedAt === null,
      )
      if (!blob) return []
      blob.purgedAt = now
      return [{ '?column?': 1 }]
    }
    if (text.startsWith('SELECT 1 FROM farm.library_blobs WHERE sha256=')) {
      const hit = state.blobs.some(
        (b) =>
          b.sha256 === values[0] &&
          b.location === 'server' &&
          b.purgedAt === null,
      )
      return hit ? [{}] : []
    }
    if (text.startsWith('SELECT DISTINCT sha256')) {
      const chunk = values[0] as string[]
      return [
        ...new Set(
          state.blobs
            .filter(
              (b) =>
                chunk.includes(b.sha256) &&
                b.location === 'server' &&
                b.purgedAt === null,
            )
            .map((b) => b.sha256),
        ),
      ].map((sha256) => ({ sha256 }))
    }
    if (text.startsWith('SELECT DISTINCT agent_id'))
      return [
        ...new Set(
          state.blobs
            .filter((b) => b.location === 'connector')
            .map((b) => b.agentId),
        ),
      ].map((agentId) => ({ agentId }))
    if (text.startsWith('SELECT sha256 FROM farm.library_blobs WHERE agent_id'))
      return state.blobs
        .filter((b) => b.agentId === values[0] && b.purgedAt === null)
        .map((b) => ({ sha256: b.sha256 }))
    throw new Error(`unexpected statement: ${text}`)
  }
  const sql = Object.assign(query, {
    // Like a real transaction: a throw undoes everything done inside it.
    begin: async <T>(work: (tx: typeof query) => Promise<T>) => {
      const snapshot = clone({ blobs: state.blobs, versions: state.versions })
      try {
        return await work(query)
      } catch (error) {
        state.blobs = snapshot.blobs
        state.versions = snapshot.versions
        throw error
      }
    },
  })
  return sql as unknown as Sql
}

const newState = (partial: Partial<State> = {}): State => ({
  blobs: [],
  versions: [],
  keepVersions: {},
  retentionDays: {},
  ...partial,
})
let counter = 0
const addBlob = (
  state: State,
  content: string,
  options: Partial<Blob> = {},
): Blob => {
  const blob: Blob = {
    farmId: FARM,
    sha256: sha(content),
    sizeBytes: content.length,
    location: 'server',
    agentId: null,
    createdAt: NOW - 90 * DAY,
    purgedAt: null,
    ...options,
  }
  if (blob.location === 'connector') blob.agentId ??= AGENT
  state.blobs.push(blob)
  return blob
}
const addVersion = (
  state: State,
  blob: Blob,
  deletedAt: number | null,
  itemId = `item-${counter}`,
  versionNumber = 1,
): Version => {
  const version: Version = {
    id: `v-${counter++}`,
    farmId: blob.farmId,
    itemId,
    versionNumber,
    sha256: blob.sha256,
    createdAt: NOW - 90 * DAY + versionNumber,
    deletedAt,
  }
  state.versions.push(version)
  return version
}
const dirs = new WeakMap<object, string>()
const store = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openfarm-retention-'))
  const blobs = await createBlobStore(dir)
  dirs.set(blobs, dir)
  return blobs
}
const put = async (
  blobs: Awaited<ReturnType<typeof store>>,
  content: string,
) => {
  const result = await blobs.put(
    (async function* () {
      yield Buffer.from(content)
    })(),
  )
  expect(result.sha256).toBe(sha(content))
}
const names = async (blobs: Awaited<ReturnType<typeof store>>) =>
  (await blobs.list()).map((f) => f.sha256).sort()
const connectorPort = (confirm = true) => {
  const calls = {
    purge: [] as [string, string[]][],
    sweep: [] as [string, string[]][],
  }
  const port: ConnectorLibraryPort = {
    purge: async (agentId, hashes) => {
      calls.purge.push([agentId, [...hashes]])
      return confirm ? [...hashes] : []
    },
    sweep: async (agentId, referenced) => {
      calls.sweep.push([agentId, [...referenced]])
      return ['f'.repeat(64)]
    },
  }
  return { port, calls }
}
const config = { batchSize: 50 }

describe('quota', () => {
  test('default is 20 GiB and the environment overrides it', () => {
    expect(DEFAULT_QUOTA_BYTES).toBe(20 * 1024 ** 3)
    expect(defaultQuotaBytes({})).toBe(DEFAULT_QUOTA_BYTES)
    expect(defaultQuotaBytes({ OPENFARM_LIBRARY_QUOTA_BYTES: '1048576' })).toBe(
      1_048_576,
    )
    for (const bad of ['-1', '1.5', 'abc', '99999999999999999'])
      expect(() =>
        defaultQuotaBytes({ OPENFARM_LIBRARY_QUOTA_BYTES: bad }),
      ).toThrow()
  })

  test('an upload over quota is refused with a clear pt-BR message', () => {
    const server = checkQuota('server', { usedBytes: 90, quotaBytes: 100 }, 20)
    expect(server).toMatchObject({ ok: false, reason: 'quota-exceeded' })
    if (!server.ok) {
      expect(server.message).toContain(
        'Cota da biblioteca excedida no servidor',
      )
      expect(server.message).toContain('20 B')
      expect(server.message).toContain('10 B')
    }
    const connector = checkQuota(
      'connector',
      { usedBytes: 0, quotaBytes: 10 },
      11,
    )
    expect(!connector.ok && connector.message).toContain('Conector')
    expect(
      checkQuota('server', { usedBytes: 90, quotaBytes: 100 }, 10),
    ).toEqual({
      ok: true,
    })
  })

  test('server mode counts unpurged server bytes; Connector mode uses the host report', async () => {
    const seen: string[] = []
    const tx = (async (strings: TemplateStringsArray) => {
      const text = strings.join('?')
      seen.push(text)
      return text.includes('library_connector_storage')
        ? [{ usedBytes: 95, quotaBytes: 100 }]
        : [{ used: 70 }]
    }) as unknown as Sql
    expect(await quotaBasis(tx, FARM, 'server', undefined, 100)).toEqual({
      usedBytes: 70,
      quotaBytes: 100,
    })
    expect(seen[0]).toContain('purged_at IS NULL')
    const basis = await quotaBasis(tx, FARM, 'connector', AGENT, 100)
    expect(basis).toEqual({ usedBytes: 95, quotaBytes: 100 })
    expect(checkQuota('connector', basis!, 6).ok).toBe(false)
    const unreported = (async () => []) as unknown as Sql
    expect(
      await quotaBasis(unreported, FARM, 'connector', AGENT, 100),
    ).toBeNull()
  })

  test('used and available space follow the active mode', () => {
    const server = summarizeUsage(
      'server',
      { usedBytes: 40, quotaBytes: 100 },
      [{ agentId: AGENT, usedBytes: 1, quotaBytes: 2, reportedAt: 1 }],
    )
    expect(server).toMatchObject({
      mode: 'server',
      usedBytes: 40,
      availableBytes: 60,
    })
    expect(server.connectors).toEqual([])
    const connector = summarizeUsage(
      'connector',
      { usedBytes: 40, quotaBytes: 100 },
      [
        {
          agentId: AGENT,
          usedBytes: 1024 ** 3,
          quotaBytes: 4 * 1024 ** 3,
          reportedAt: 5,
        },
      ],
    )
    expect(connector).toMatchObject({
      mode: 'connector',
      availableBytes: 3 * 1024 ** 3,
    })
    expect(describeUsage(connector)).toBe(
      '1 GiB usados de 4 GiB (3 GiB livres)',
    )
    const none = summarizeUsage(
      'connector',
      { usedBytes: 0, quotaBytes: 0 },
      [],
    )
    expect(none.unreported).toBe(true)
    expect(describeUsage(none)).toContain('ainda não informou')
  })

  test('a Connector report needs an approved Connector of the farm', async () => {
    const writes: unknown[][] = []
    const make = (enrolled: boolean) => {
      const query = async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const text = strings.join('?')
        if (text.includes('connector_enrollments')) return enrolled ? [{}] : []
        writes.push(values)
        return []
      }
      return Object.assign(query, {
        begin: async <T>(work: (tx: typeof query) => Promise<T>) => work(query),
      }) as unknown as Sql
    }
    const report = {
      farmId: FARM,
      agentId: AGENT,
      quotaBytes: 100,
      usedBytes: 10,
    }
    expect(await recordConnectorStorage(make(false), report, NOW)).toEqual({
      ok: false,
      reason: 'forbidden',
    })
    expect(writes).toHaveLength(0)
    expect(await recordConnectorStorage(make(true), report, NOW)).toEqual({
      ok: true,
    })
    expect(writes[0]).toContain(100)
    expect(
      await recordConnectorStorage(
        make(true),
        { ...report, usedBytes: -1 },
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'invalid-input' })
  })
})

describe('retention rules', () => {
  const facts = (over: Partial<BlobFacts>): BlobFacts => ({
    farmId: FARM,
    sha256: sha('x'),
    sizeBytes: 1,
    location: 'server',
    agentId: null,
    createdAt: NOW - 90 * DAY,
    retentionDays: 30,
    refs: 1,
    live: false,
    newestDeletedAt: NOW - 31 * DAY,
    ...over,
  })

  test('purge needs every version soft-deleted for the whole window', () => {
    expect(isPurgeable(facts({}), NOW)).toBe(true)
    expect(isPurgeable(facts({ newestDeletedAt: NOW - 29 * DAY }), NOW)).toBe(
      false,
    )
    expect(isPurgeable(facts({ live: true }), NOW)).toBe(false)
    expect(isPurgeable(facts({ retentionDays: 90 }), NOW)).toBe(false)
  })

  test('an unreferenced blob goes only after the in-flight grace', () => {
    const orphan = facts({ refs: 0, newestDeletedAt: null })
    expect(isPurgeable(orphan, NOW)).toBe(true)
    expect(isPurgeable({ ...orphan, createdAt: NOW - 60_000 }, NOW)).toBe(false)
  })

  test('replay of a purged version says "arquivo removido"', () => {
    expect(PURGED_LABEL).toBe('arquivo removido')
    expect(replayAvailability({ purgedAt: null })).toEqual({ available: true })
    expect(replayAvailability({ purgedAt: NOW })).toEqual({
      available: false,
      label: 'arquivo removido',
    })
  })

  test('config is off by default and rejects unsafe values', () => {
    expect(parseLibraryRetentionConfig({ enabled: false })).toBeUndefined()
    expect(
      parseLibraryRetentionConfig({
        enabled: true,
        databaseUrl: 'postgresql://retention@localhost/farm',
      }),
    ).toEqual({
      databaseUrl: 'postgresql://retention@localhost/farm',
      intervalMs: 3_600_000,
      batchSize: 100,
    })
    for (const bad of [
      { databaseUrl: 'file:db' },
      { databaseUrl: 'postgres://h/db', intervalMs: 1 },
      { databaseUrl: 'postgres://h/db', batchSize: 1001 },
    ])
      expect(() =>
        parseLibraryRetentionConfig({ enabled: true, ...bad }),
      ).toThrow()
  })
})

describe('server mode purge', () => {
  test('purges unreferenced blobs and keeps referenced ones', async () => {
    const state = newState()
    const blobs = await store()
    const expired = addBlob(state, 'expired')
    const recent = addBlob(state, 'recent')
    const live = addBlob(state, 'live')
    const mixed = addBlob(state, 'mixed')
    addVersion(state, expired, NOW - 31 * DAY)
    addVersion(state, recent, NOW - 10 * DAY)
    addVersion(state, live, null)
    addVersion(state, mixed, NOW - 60 * DAY, 'item-m', 1)
    addVersion(state, mixed, null, 'item-m2', 1)
    for (const text of ['expired', 'recent', 'live', 'mixed'])
      await put(blobs, text)

    const result = await runLibraryRetention(
      { sql: fakeSql(state), blobs, clock: () => NOW },
      config,
    )

    expect(result).toMatchObject({
      blobsPurged: 1,
      bytesFreed: 7,
      failed: 0,
      deferred: 0,
    })
    expect(await names(blobs)).toEqual(
      [recent, live, mixed].map((b) => b.sha256).sort(),
    )
    expect(state.blobs.find((b) => b.sha256 === expired.sha256)?.purgedAt).toBe(
      NOW,
    )
    for (const kept of [recent, live, mixed])
      expect(
        state.blobs.find((b) => b.sha256 === kept.sha256)?.purgedAt,
      ).toBeNull()
  })

  test('the stored file stays while another farm still uses the same bytes', async () => {
    const state = newState()
    const blobs = await store()
    const shared = addBlob(state, 'shared')
    const other = addBlob(state, 'shared', { farmId: FARM2 })
    addVersion(state, shared, NOW - 40 * DAY)
    addVersion(state, other, null)
    await put(blobs, 'shared')

    await runLibraryRetention(
      { sql: fakeSql(state), blobs, clock: () => NOW },
      config,
    )

    expect(state.blobs[0]?.purgedAt).toBe(NOW)
    expect(state.blobs[1]?.purgedAt).toBeNull()
    expect(await names(blobs)).toEqual([sha('shared')])
  })

  test('a blob that became referenced after the candidate scan is kept', async () => {
    const state = newState({ staleCandidates: true })
    const blobs = await store()
    const blob = addBlob(state, 'raced')
    addVersion(state, blob, NOW - 40 * DAY, 'old')
    await put(blobs, 'raced')
    state.afterLock = (s) => {
      // A repeat upload adds a live reference while the purge waits for the farm lock.
      addVersion(s, blob, null, 'fresh')
      s.afterLock = undefined
    }

    const result = await runLibraryRetention(
      { sql: fakeSql(state), blobs, clock: () => NOW },
      config,
    )

    expect(result.blobsPurged).toBe(0)
    expect(state.blobs[0]?.purgedAt).toBeNull()
    expect(await names(blobs)).toEqual([sha('raced')])
  })

  test('without a disk the purge is deferred, not marked', async () => {
    const state = newState()
    const blob = addBlob(state, 'gone')
    addVersion(state, blob, NOW - 40 * DAY)
    const result = await runLibraryRetention(
      { sql: fakeSql(state), clock: () => NOW },
      config,
    )
    expect(result).toMatchObject({ blobsPurged: 0, deferred: 1 })
    expect(state.blobs[0]?.purgedAt).toBeNull()
  })

  test('files no blob row references are swept after the grace; others stay', async () => {
    const state = newState()
    const blobs = await store()
    const known = addBlob(state, 'known')
    addVersion(state, known, null)
    await put(blobs, 'known')
    await put(blobs, 'orphan-old')
    await put(blobs, 'orphan-new')
    const old = new Date(NOW - 2 * 3_600_000)
    // The clock is NOW (fixed); give each file an mtime relative to it.
    const listed = await blobs.list()
    for (const file of listed) {
      const stamp =
        file.sha256 === sha('orphan-new') ? new Date(NOW - 60_000) : old
      await utimes(join(dirs.get(blobs)!, file.sha256), stamp, stamp)
    }

    const result = await runLibraryRetention(
      { sql: fakeSql(state), blobs, clock: () => NOW },
      config,
    )

    expect(result.serverFilesSwept).toBe(1)
    expect(await names(blobs)).toEqual([sha('known'), sha('orphan-new')].sort())
  })

  test('blob store removes one file and reports absence', async () => {
    const blobs = await store()
    await put(blobs, 'one')
    expect(await blobs.remove(sha('one'))).toBe(true)
    expect(await blobs.remove(sha('one'))).toBe(false)
    await expect(blobs.remove('../x')).rejects.toThrow()
  })
})

describe('Connector mode', () => {
  test('purge runs on the Connector host and keeps referenced blobs', async () => {
    const state = newState()
    const expired = addBlob(state, 'c-expired', { location: 'connector' })
    const live = addBlob(state, 'c-live', { location: 'connector' })
    addVersion(state, expired, NOW - 31 * DAY)
    addVersion(state, live, null)
    const { port, calls } = connectorPort()

    const result = await runLibraryRetention(
      { sql: fakeSql(state), connectors: port, clock: () => NOW },
      config,
    )

    expect(result.blobsPurged).toBe(1)
    expect(calls.purge).toEqual([[AGENT, [expired.sha256]]])
    expect(
      state.blobs.find((b) => b.sha256 === live.sha256)?.purgedAt,
    ).toBeNull()
    // The sweep is told only about files still referenced.
    expect(calls.sweep).toEqual([[AGENT, [live.sha256]]])
    expect(result.connectorFilesSwept).toBe(1)
  })

  test('an unconfirmed Connector purge rolls back and retries later', async () => {
    const state = newState()
    const blob = addBlob(state, 'c-stuck', { location: 'connector' })
    addVersion(state, blob, NOW - 31 * DAY)
    const { port } = connectorPort(false)

    const result = await runLibraryRetention(
      { sql: fakeSql(state), connectors: port, clock: () => NOW },
      config,
    )

    expect(result).toMatchObject({ blobsPurged: 0, failed: 1 })
    expect(state.blobs[0]?.purgedAt).toBeNull()
  })

  test('no Connector transport: Connector blobs are deferred and server blobs still purge', async () => {
    const state = newState()
    const blobs = await store()
    const c = addBlob(state, 'c-wait', { location: 'connector' })
    const s = addBlob(state, 's-go')
    addVersion(state, c, NOW - 31 * DAY)
    addVersion(state, s, NOW - 31 * DAY)
    await put(blobs, 's-go')

    const result = await runLibraryRetention(
      { sql: fakeSql(state), blobs, clock: () => NOW },
      config,
    )

    expect(result).toMatchObject({ blobsPurged: 1, deferred: 1 })
    expect(state.blobs.find((b) => b.sha256 === c.sha256)?.purgedAt).toBeNull()
  })
})

describe('keep newest N versions', () => {
  test('older live versions beyond N are soft-deleted, not purged', async () => {
    const state = newState({ keepVersions: { [FARM]: 2 } })
    const blobs: Blob[] = []
    for (let n = 1; n <= 4; n++) {
      const blob = addBlob(state, `v${n}`)
      blobs.push(blob)
      addVersion(state, blob, null, 'item-keep', n)
    }
    const other = addBlob(state, 'other-farm', { farmId: FARM2 })
    addVersion(state, other, null, 'item-other', 1)

    const result = await runLibraryRetention(
      { sql: fakeSql(state), blobs: await store(), clock: () => NOW },
      config,
    )

    expect(result.versionsTrimmed).toBe(2)
    expect(
      state.versions
        .filter((v) => v.itemId === 'item-keep')
        .map((v) => [v.versionNumber, v.deletedAt]),
    ).toEqual([
      [1, NOW],
      [2, NOW],
      [3, null],
      [4, null],
    ])
    expect(
      state.versions.find((v) => v.itemId === 'item-other')?.deletedAt,
    ).toBeNull()
    expect(result.blobsPurged).toBe(0)
  })
})
