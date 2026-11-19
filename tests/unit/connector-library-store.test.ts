import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConnectorLibraryStore,
  LibraryStoreError,
} from '../../packages/connector/src/library/store.ts'

const directories: string[] = []
async function store(
  options: {
    quotaBytes?: number
    keepNewestPerItem?: number
    now?: () => number
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'connector-library-'))
  directories.push(directory)
  return new ConnectorLibraryStore({
    directory,
    quotaBytes: options.quotaBytes ?? 1024,
    ...options,
  })
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('ConnectorLibraryStore', () => {
  it('deduplicates content, lists metadata only, and verifies bytes before print', async () => {
    const library = await store()
    const bytes = Buffer.from('gcode payload')
    const first = await library.put({
      id: 'v1',
      itemId: 'part',
      name: 'part.gcode',
      bytes,
      thumbnail: 'cG5n',
    })
    const second = await library.put({
      id: 'v2',
      itemId: 'part',
      name: 'copy.gcode',
      bytes,
    })
    expect(first.sha256).toBe(second.sha256)
    expect(await library.report()).toMatchObject({
      usedBytes: bytes.length,
      files: [{ id: 'v1', thumbnail: 'cG5n' }, { id: 'v2' }],
    })
    expect(await library.readForPrint('v1')).toEqual(bytes)
    await writeFile(
      join(
        (library as any).options.directory,
        first.sha256.slice(0, 2),
        first.sha256.slice(2),
      ),
      'corrupt',
    )
    await expect(library.readForPrint('v1')).rejects.toMatchObject<
      Partial<LibraryStoreError>
    >({ reason: 'hash-mismatch' })
  })

  it('evicts oldest unpinned versions to satisfy quota and retention and reports removals', async () => {
    let time = 1
    const library = await store({
      quotaBytes: 5,
      keepNewestPerItem: 1,
      now: () => time++,
    })
    await library.put({
      id: 'old',
      itemId: 'part',
      name: 'old',
      bytes: Buffer.from('12345'),
    })
    await library.put({
      id: 'new',
      itemId: 'part',
      name: 'new',
      bytes: Buffer.from('abcde'),
    })
    expect((await library.report()).removed).toContain('old')
    expect(library.list().map(({ id }) => id)).toEqual(['new'])
    await expect(
      library.put({
        id: 'too-big',
        itemId: 'x',
        name: 'x',
        bytes: Buffer.from('123456'),
      }),
    ).rejects.toMatchObject({ reason: 'full-disk' })
  })

  it('reports missing content and migrates every available version over the session adapter', async () => {
    const library = await store()
    const bytes = Buffer.from('version one')
    const version = await library.put({
      id: 'v1',
      itemId: 'part',
      name: 'part.gcode',
      bytes,
    })
    const remote = new Map<string, Uint8Array>()
    expect(
      await library.switchMode('server', {
        put: async (meta, payload) => {
          remote.set(meta.id, payload)
        },
        get: async () => {
          throw Error('unused')
        },
      }),
    ).toEqual({ moved: ['v1'], stayed: [] })
    expect(remote.get('v1')).toEqual(bytes)
    expect(library.list()).toEqual([])
    const replay = await store()
    expect(
      await replay.switchMode(
        'connector',
        { put: async () => {}, get: async () => bytes },
        [version],
      ),
    ).toEqual({ moved: ['v1'], stayed: [] })
    expect(await replay.readForPrint('v1')).toEqual(bytes)
    await expect(library.readForPrint('v1')).rejects.toMatchObject({
      reason: 'missing-file',
    })
    expect(version.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('keeps a version in the per-version stay list if transfer fails or has a hash mismatch', async () => {
    const library = await store()
    const version = await library.put({
      id: 'v1',
      itemId: 'part',
      name: 'part.gcode',
      bytes: Buffer.from('original'),
    })
    const empty = await store()
    expect(
      await empty.switchMode(
        'connector',
        { put: async () => {}, get: async () => Buffer.from('wrong') },
        [version],
      ),
    ).toEqual({ moved: [], stayed: ['v1'] })
    expect(empty.list()).toEqual([])
  })
})
