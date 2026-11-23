import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLibraryStore } from '../../packages/connector/src/runtime/library-store.ts'

const directories: string[] = []
const bytes = (value: string): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield Buffer.from(value)
  })()
const meta = (version_id: string, version_number: number) => ({
  version_id,
  item_id: 'part',
  version_number,
  name: `${version_id}.gcode`,
  kind: 'gcode' as const,
})
async function store(
  options: {
    quotaBytes?: number
    keepVersions?: number
    clock?: () => number
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'connector-library-'))
  directories.push(directory)
  return {
    directory,
    library: await createLibraryStore({
      directory,
      quotaBytes: 1024,
      ...options,
    }),
  }
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('shipped Connector library contract', () => {
  it('deduplicates content, lists metadata only, and verifies bytes before print', async () => {
    const { library, directory } = await store()
    const first = await library.put(bytes('gcode payload'), {
      meta: { ...meta('v1', 1), thumbnail: 'cG5n' },
    })
    const second = await library.put(bytes('gcode payload'), {
      meta: meta('v2', 2),
    })
    expect(first.sha256).toBe(second.sha256)
    expect(second.deduplicated).toBe(true)
    expect((await library.report()).used_bytes).toBe(
      Buffer.byteLength('gcode payload'),
    )
    expect((await library.list()).map((v) => v.version_id).sort()).toEqual([
      'v1',
      'v2',
    ])
    expect(
      (await library.list()).find((v) => v.version_id === 'v1')?.thumbnail,
    ).toBe('cG5n')
    expect(JSON.stringify(await library.list())).not.toContain('gcode payload')
    expect((await library.openForPrint(first.sha256)).size).toBe(
      Buffer.byteLength('gcode payload'),
    )
    const verified = await library.readVerified(first.sha256)
    const chunks: Buffer[] = []
    for await (const chunk of verified.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('gcode payload'))
    await writeFile(join(directory, first.sha256), 'corrupt')
    await expect(library.openForPrint(first.sha256)).rejects.toMatchObject({
      code: 'hash-mismatch',
    })
  })

  it('evicts unpinned content to satisfy quota and reports removals', async () => {
    let time = 1
    const { library } = await store({ quotaBytes: 5, clock: () => time++ })
    const old = await library.put(bytes('12345'), { meta: meta('old', 1) })
    const next = await library.put(bytes('abcde'), {
      meta: meta('new', 2),
      evictToFit: true,
    })
    expect(next.evicted).toMatchObject([
      { sha256: old.sha256, version_ids: ['old'], reason: 'quota' },
    ])
    expect(
      (await library.list()).find((v) => v.version_id === 'old')?.state,
    ).toBe('removed')
    await expect(
      library.put(bytes('123456'), { meta: meta('too-big', 1) }),
    ).rejects.toMatchObject({ code: 'quota-exceeded' })
    await expect(library.openForPrint(old.sha256)).rejects.toMatchObject({
      code: 'not-found',
    })
  })
})
