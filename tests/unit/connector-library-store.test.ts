import { createHash } from 'node:crypto'
import { mkdtemp, rm, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createLibraryStore,
  LibraryStoreError,
  type LibraryStoreOptions,
  type VersionMeta,
} from '../../packages/connector/src/runtime/library-store.ts'
import {
  LibraryListResponse,
  LibraryStorageReport,
} from '../../packages/farm-protocol/src/library-storage.ts'

const DAY = 86_400_000
const HOUR = 3_600_000
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const bytes = (text: string): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield Buffer.from(text)
  })()
const PNG = Buffer.concat([
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
  Buffer.from('thumb'),
]).toString('base64')

let counter = 0
const directories = new Set<string>()
afterEach(async () => {
  await Promise.all(
    [...directories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
  directories.clear()
})
const meta = (name: string, over: Partial<VersionMeta> = {}): VersionMeta => ({
  version_id: `v${++counter}`,
  item_id: 'item1',
  version_number: counter,
  name,
  kind: 'gcode',
  ...over,
})

async function open(options: Partial<LibraryStoreOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'connector-library-'))
  directories.add(directory)
  let now = 1_800_000_000_000
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  const store = await createLibraryStore({
    directory,
    clock: clock.now,
    freeBytes: async () => 1e12,
    ...options,
  })
  return { store, directory, clock }
}
const stored = async (directory: string) =>
  (await readdir(directory)).filter((name) => /^[0-9a-f]{64}$/.test(name))
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: LibraryStoreError) => error.code,
  )

describe('content-addressed writes', () => {
  test('stores the same file twice as one copy', async () => {
    const { store, directory } = await open()
    const first = await store.put(bytes('G28'), { meta: meta('a.gcode') })
    const second = await store.put(bytes('G28'), { meta: meta('b.gcode') })
    expect(first).toMatchObject({
      sha256: sha('G28'),
      created: true,
      deduplicated: false,
    })
    expect(second).toMatchObject({ created: false, deduplicated: true })
    expect(await stored(directory)).toEqual([sha('G28')])
    expect((await store.usage()).usedBytes).toBe(3)
    expect(await store.list()).toHaveLength(2)
  })

  test('writes atomically: a crash before the rename leaves no file and no temp', async () => {
    const { store, directory } = await open()
    await expect(
      store.put(bytes('G1 X1'), {
        beforeRename: () => {
          throw new Error('crash')
        },
      }),
    ).rejects.toThrow('crash')
    expect(await stored(directory)).toEqual([])
    expect(await readdir(join(directory, '.tmp'))).toEqual([])
  })

  test('refuses bytes that do not match the expected hash or size', async () => {
    const { store, directory } = await open()
    expect(
      await code(store.put(bytes('abc'), { expectedSha256: sha('xyz') })),
    ).toBe('hash-mismatch')
    expect(
      await code(
        store.put(bytes('abc'), {
          expectedSha256: sha('abc'),
          expectedSize: 5,
        }),
      ),
    ).toBe('hash-mismatch')
    expect(await code(store.put(bytes('abcdef'), { expectedSize: 3 }))).toBe(
      'hash-mismatch',
    )
    expect(await stored(directory)).toEqual([])
    expect(await readdir(join(directory, '.tmp'))).toEqual([])
  })

  test('rejects a malformed hash and a relative directory', async () => {
    const { store } = await open()
    expect(await code(store.has('../etc/passwd'))).toBe('invalid-hash')
    await expect(
      createLibraryStore({ directory: 'relative' }),
    ).rejects.toMatchObject({
      code: 'invalid-directory',
    })
  })
})

describe('verification before print', () => {
  test('a corrupted file fails verification and is never opened for print', async () => {
    const { store, directory } = await open()
    const { sha256 } = await store.put(bytes('good bytes'))
    expect((await store.openForPrint(sha256)).size).toBe(10)
    await writeFile(join(directory, sha256), 'bad bytes!')
    expect(await code(store.openForPrint(sha256))).toBe('hash-mismatch')
    expect(await code(store.readVerified(sha256))).toBe('hash-mismatch')
  })

  test('uploading the same bytes again repairs a corrupt copy instead of deduplicating onto it', async () => {
    const { store, directory } = await open()
    const { sha256 } = await store.put(bytes('good bytes'))
    await writeFile(join(directory, sha256), 'bad bytes!')
    const again = await store.put(bytes('good bytes'))
    expect(again).toMatchObject({
      repaired: true,
      deduplicated: false,
      created: true,
    })
    expect((await store.openForPrint(sha256)).sha256).toBe(sha256)
  })

  test('a missing file reports a clear pt-BR error and lists as missing', async () => {
    const { store, directory } = await open()
    const { sha256 } = await store.put(bytes('gone'), {
      meta: meta('gone.gcode'),
    })
    const { unlink } = await import('node:fs/promises')
    await unlink(join(directory, sha256))
    const error = await store
      .openForPrint(sha256)
      .catch((e: LibraryStoreError) => e)
    expect(error).toMatchObject({ code: 'not-found' })
    expect((error as LibraryStoreError).userMessage).toMatch(/não encontrado/)
    expect((await store.list())[0]?.state).toBe('missing')
  })
})

describe('full disk', () => {
  test('refuses an upload that does not fit the volume, before accepting any byte', async () => {
    const { store, directory } = await open({ freeBytes: async () => 2 })
    const error = await store
      .put(bytes('12345'), { expectedSize: 5 })
      .catch((e: LibraryStoreError) => e)
    expect(error).toMatchObject({ code: 'disk-full' })
    expect((error as LibraryStoreError).userMessage).toMatch(/Disco cheio/)
    expect(await stored(directory)).toEqual([])
  })

  test('maps ENOSPC during the write to the same error and drops the temp file', async () => {
    const { store, directory } = await open()
    const source = (async function* () {
      yield Buffer.from('partial')
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
    })()
    expect(await code(store.put(source))).toBe('disk-full')
    expect(await readdir(join(directory, '.tmp'))).toEqual([])
  })
})

describe('quota', () => {
  test('refuses an upload that does not fit, with accessible pt-BR text, and stores nothing', async () => {
    const { store, directory } = await open({ quotaBytes: 8 })
    await store.put(bytes('12345'))
    const error = await store
      .put(bytes('abcde'))
      .catch((e: LibraryStoreError) => e)
    expect(error).toMatchObject({ code: 'quota-exceeded' })
    expect((error as LibraryStoreError).userMessage).toMatch(
      /Cota da biblioteca excedida no computador do Conector/,
    )
    expect(await stored(directory)).toEqual([sha('12345')])
  })

  test('evictToFit removes the oldest unpinned versions and reports them; pinned survive', async () => {
    const { store, clock } = await open({ quotaBytes: 12 })
    const old = meta('old.gcode')
    const pinned = meta('pinned.gcode')
    const newer = meta('newer.gcode')
    await store.put(bytes('1111'), { meta: old })
    clock.advance(1000)
    await store.put(bytes('2222'), { meta: pinned, pinned: true })
    clock.advance(1000)
    await store.put(bytes('3333'), { meta: newer })
    const result = await store.put(bytes('4444'), { evictToFit: true })
    expect(result.evicted).toEqual([
      {
        sha256: sha('1111'),
        size_bytes: 4,
        version_ids: [old.version_id],
        reason: 'quota',
      },
    ])
    const states = Object.fromEntries(
      (await store.list()).map((f) => [f.name, f.state]),
    )
    expect(states).toEqual({
      'old.gcode': 'removed',
      'pinned.gcode': 'stored',
      'newer.gcode': 'stored',
    })
  })

  test('evictToFit refuses, evicting nothing, when pinned files leave no room', async () => {
    const { store, directory } = await open({ quotaBytes: 8 })
    await store.put(bytes('1111'), { meta: meta('a.gcode'), pinned: true })
    await store.put(bytes('2222'), { meta: meta('b.gcode'), pinned: true })
    expect(await code(store.put(bytes('3333'), { evictToFit: true }))).toBe(
      'quota-exceeded',
    )
    expect(await stored(directory)).toHaveLength(2)
  })

  test('a lowered quota evicts the oldest unpinned versions and reports what went', async () => {
    const { store, clock } = await open({ quotaBytes: 100 })
    const first = meta('1.gcode')
    await store.put(bytes('aaaa'), { meta: first })
    clock.advance(1)
    await store.put(bytes('bbbb'), { meta: meta('2.gcode'), pinned: true })
    clock.advance(1)
    await store.put(bytes('cccc'), { meta: meta('3.gcode') })
    store.configure({ quotaBytes: 8 })
    const removed = await store.enforceQuota()
    expect(removed.map((r) => [r.sha256, r.reason])).toEqual([
      [sha('aaaa'), 'quota'],
    ])
    expect((await store.usage()).availableBytes).toBe(0)
  })

  test('reports quota and usage in the session frame shape', async () => {
    const { store } = await open({ quotaBytes: 100, keepVersions: 3 })
    await store.put(bytes('abcd'))
    expect(LibraryStorageReport.parse(await store.report())).toMatchObject({
      quota_bytes: 100,
      used_bytes: 4,
      retention_days: 30,
      keep_versions: 3,
    })
  })
})

describe('retention (same rules as server mode)', () => {
  test('keep-newest-N soft-deletes older versions, then the window purges unpinned ones', async () => {
    const { store, directory, clock } = await open({ keepVersions: 1 })
    const v1 = meta('v1.gcode', { version_number: 1 })
    const v2 = meta('v2.gcode', { version_number: 2 })
    await store.put(bytes('one'), { meta: v1 })
    await store.put(bytes('two'), { meta: v2 })
    const first = await store.applyRetention()
    expect(first.trimmed).toEqual([v1.version_id])
    expect(first.removed).toEqual([])
    clock.advance(29 * DAY)
    expect((await store.applyRetention()).removed).toEqual([])
    clock.advance(2 * DAY)
    const purged = await store.applyRetention()
    expect(purged.removed).toEqual([
      {
        sha256: sha('one'),
        size_bytes: 3,
        version_ids: [v1.version_id],
        reason: 'retention',
      },
    ])
    const states = Object.fromEntries(
      (await store.list()).map((f) => [f.name, f.state]),
    )
    expect(states).toEqual({ 'v1.gcode': 'removed', 'v2.gcode': 'stored' })
    expect(await stored(directory)).toEqual([sha('two')])
  })

  test('pinned versions are never trimmed or purged; identical bytes uploaded again restore a removed version', async () => {
    const { store, clock } = await open({ keepVersions: 1 })
    const pinned = meta('p.gcode', { version_number: 1 })
    const gone = meta('g.gcode', { version_number: 2, item_id: 'item2' })
    await store.put(bytes('pin'), { meta: pinned, pinned: true })
    await store.put(bytes('new'), {
      meta: meta('n.gcode', { version_number: 2 }),
    })
    await store.put(bytes('gone'), { meta: gone })
    await store.softDelete(gone.version_id)
    clock.advance(31 * DAY)
    const result = await store.applyRetention()
    expect(result.trimmed).toEqual([])
    expect(result.removed.map((r) => r.sha256)).toEqual([sha('gone')])
    await store.put(bytes('gone'))
    expect((await store.list()).find((f) => f.name === 'g.gcode')?.state).toBe(
      'stored',
    )
  })

  test('purge confirms an absent file as removed; sweep keeps young and referenced files', async () => {
    const { store, directory, clock } = await open()
    const a = await store.put(bytes('aaa'))
    const b = await store.put(bytes('bbb'))
    const c = await store.put(bytes('ccc'))
    const never = sha('never stored')
    expect(await store.purge([a.sha256, never])).toEqual([a.sha256, never])
    // The injected clock is far ahead of the real mtime: stamp files "now" first.
    for (const file of [b, c])
      await utimes(
        join(directory, file.sha256),
        clock.now() / 1000,
        clock.now() / 1000,
      )
    expect(await store.sweep([b.sha256])).toEqual([]) // young: inside the grace period
    clock.advance(2 * HOUR)
    expect(await store.sweep([b.sha256])).toEqual([c.sha256])
    expect(await stored(directory)).toEqual([b.sha256])
  })
})

describe('what the server sees', () => {
  test('lists metadata, thumbnail and hash only; the file bytes never appear', async () => {
    const { store } = await open()
    const secret = 'G1 SECRET-TOOLPATH'
    await store.put(bytes(secret), {
      meta: meta('peça.gcode', { thumbnail: PNG }),
    })
    const files = await store.list()
    const frame = {
      type: 'library.files.list.result',
      request_id: 'r1',
      ok: true,
      files,
    }
    const parsed = LibraryListResponse.parse(frame)
    expect(JSON.stringify(parsed)).not.toContain('SECRET-TOOLPATH')
    expect(files[0]).toMatchObject({
      sha256: sha(secret),
      size_bytes: secret.length,
      thumbnail: PNG,
      state: 'stored',
    })
    expect(
      LibraryListResponse.safeParse({
        ...frame,
        files: [{ ...files[0], bytes: 'x' }],
      }).success,
    ).toBe(false)
  })

  test('survives a restart: the listing is rebuilt from the index', async () => {
    const { store, directory, clock } = await open()
    await store.put(bytes('persist'), { meta: meta('keep.gcode') })
    const reopened = await createLibraryStore({ directory, clock: clock.now })
    expect((await reopened.list()).map((f) => f.name)).toEqual(['keep.gcode'])
    expect((await stat(join(directory, 'index.json'))).isFile()).toBe(true)
  })

  test('refuses to run on an unreadable index instead of overwriting it', async () => {
    const { directory } = await open()
    await writeFile(join(directory, 'index.json'), '{not json')
    expect(await code(createLibraryStore({ directory }))).toBe(
      'index-unreadable',
    )
  })
})
