import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  createLibraryCache,
  LibraryCacheError,
  type LibraryDownloader,
} from '../../packages/connector/src/runtime/library-cache.ts'

const sha = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex')
const signal = new AbortController().signal

/** Real directory under the worktree's ignored `.data/`; nothing else is touched. */
async function directory() {
  await mkdir(join(process.cwd(), '.data'), { recursive: true })
  return mkdtemp(join(process.cwd(), '.data', 'library-cache-'))
}
const stored = async (dir: string) =>
  (await readdir(dir)).filter((name) => /^[0-9a-f]{64}$/.test(name)).sort()

/** In-process "server": serves `blobs` by hash and counts every download. */
function server(blobs: Record<string, Buffer>, announce = true) {
  const calls: string[] = []
  const download: LibraryDownloader = async (hash) => {
    calls.push(hash)
    const body = blobs[hash]
    if (!body) throw new Error('404')
    return {
      ...(announce ? { size: body.length } : {}),
      stream: (async function* () {
        yield body.subarray(0, 3)
        yield body.subarray(3)
      })(),
    }
  }
  return { download, calls }
}
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: LibraryCacheError) => error.code,
  )

describe('library cache', () => {
  test('downloads once and reuses the verified copy', async () => {
    const body = Buffer.from('G28\nG1 X10\n')
    const hash = sha(body)
    const { download, calls } = server({ [hash]: body })
    const dir = await directory()
    const cache = await createLibraryCache({ directory: dir, maxBytes: 1024 })

    const first = await cache.acquire(hash, download, signal)
    expect(first.reused).toBe(false)
    first.release()
    const second = await cache.acquire(hash, download, signal)
    expect(second.reused).toBe(true)
    expect(second.path).toBe(first.path)
    second.release()
    expect(calls).toEqual([hash])
    expect(await stored(dir)).toEqual([hash])
  })

  test('refuses a tampered blob and keeps nothing', async () => {
    const wanted = sha('the real file')
    const { download } = server({ [wanted]: Buffer.from('a swapped file') })
    const dir = await directory()
    const cache = await createLibraryCache({ directory: dir, maxBytes: 1024 })
    expect(await code(cache.acquire(wanted, download, signal))).toBe(
      'checksum-mismatch',
    )
    expect(await stored(dir)).toEqual([])
    expect(await readdir(join(dir, '.tmp'))).toEqual([])
  })

  test('replaces a cached copy that was altered on disk', async () => {
    const body = Buffer.from('G28\nG1 X10\n')
    const hash = sha(body)
    const { download, calls } = server({ [hash]: body })
    const dir = await directory()
    const cache = await createLibraryCache({ directory: dir, maxBytes: 1024 })
    ;(await cache.acquire(hash, download, signal)).release()
    await writeFile(join(dir, hash), 'tampered')

    const again = await cache.acquire(hash, download, signal)
    expect(again.reused).toBe(false)
    expect(calls).toHaveLength(2)
    again.release()
  })

  test('evicts the least recently used idle file to stay under the cap', async () => {
    const files = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].map((t) =>
      Buffer.from(t),
    )
    const [a, b, c] = files.map(sha) as [string, string, string]
    const { download } = server({
      [a]: files[0]!,
      [b]: files[1]!,
      [c]: files[2]!,
    })
    const dir = await directory()
    const cache = await createLibraryCache({ directory: dir, maxBytes: 100 })
    ;(await cache.acquire(a, download, signal)).release()
    await new Promise((resolve) => setTimeout(resolve, 15))
    ;(await cache.acquire(b, download, signal)).release()
    await new Promise((resolve) => setTimeout(resolve, 15))
    // Touching `a` makes `b` the oldest.
    ;(await cache.acquire(a, download, signal)).release()
    await new Promise((resolve) => setTimeout(resolve, 15))
    ;(await cache.acquire(c, download, signal)).release()

    expect(await stored(dir)).toEqual([a, c].sort())
    expect(await cache.usedBytes()).toBeLessThanOrEqual(100)
  })

  test('reports cache-full for a file over the cap, announced or not', async () => {
    const big = Buffer.from('x'.repeat(200))
    const hash = sha(big)
    for (const announce of [true, false]) {
      const { download } = server({ [hash]: big }, announce)
      const dir = await directory()
      const cache = await createLibraryCache({ directory: dir, maxBytes: 100 })
      expect(await code(cache.acquire(hash, download, signal))).toBe(
        'cache-full',
      )
      expect(await stored(dir)).toEqual([])
    }
  })

  test('never evicts a file a start is still using', async () => {
    const one = Buffer.from('1'.repeat(60))
    const two = Buffer.from('2'.repeat(60))
    const { download } = server({ [sha(one)]: one, [sha(two)]: two })
    const dir = await directory()
    const cache = await createLibraryCache({ directory: dir, maxBytes: 100 })
    const held = await cache.acquire(sha(one), download, signal)
    expect(await code(cache.acquire(sha(two), download, signal))).toBe(
      'cache-full',
    )
    expect(await stored(dir)).toEqual([sha(one)])
    held.release()
    ;(await cache.acquire(sha(two), download, signal)).release()
    expect(await stored(dir)).toEqual([sha(two)])
  })

  test('maps a failing download and a bad hash to download-failed', async () => {
    const dir = await directory()
    const cache = await createLibraryCache({ directory: dir, maxBytes: 100 })
    const { download } = server({})
    expect(await code(cache.acquire(sha('missing'), download, signal))).toBe(
      'download-failed',
    )
    expect(await code(cache.acquire('../escape', download, signal))).toBe(
      'download-failed',
    )
  })
})
