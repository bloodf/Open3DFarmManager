import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MAX_FILE_SIZE } from '../../../farm-protocol/src/file-transfer.ts'

/**
 * Server-mode library cache on the Connector host (#384): files fetched from
 * the server for a print start, content-addressed at `<directory>/<sha256>`.
 * Bounded by `maxBytes` with least-recently-used eviction; a file in use by a
 * start is never evicted. Every download is hashed while it is written and a
 * reused file is hashed again before it is handed out.
 */
const SHA256 = /^[0-9a-f]{64}$/
const TMP_DIR = '.tmp'

export type LibraryCacheErrorCode =
  'download-failed' | 'checksum-mismatch' | 'cache-full'

export class LibraryCacheError extends Error {
  readonly code: LibraryCacheErrorCode
  constructor(code: LibraryCacheErrorCode) {
    super(code)
    this.name = 'LibraryCacheError'
    this.code = code
  }
}

/** One download of a server-mode file; `size` is the announced length when known. */
export interface LibraryDownload {
  size?: number
  stream: AsyncIterable<Uint8Array>
}
export type LibraryDownloader = (
  sha256: string,
  signal: AbortSignal,
) => Promise<LibraryDownload>

export interface CachedFile {
  sha256: string
  size: number
  /** Valid until `release()`; the file cannot be evicted before then. */
  path: string
  /** Served from disk with no download. */
  reused: boolean
  release(): void
}

export interface LibraryCache {
  acquire(
    sha256: string,
    download: LibraryDownloader,
    signal: AbortSignal,
  ): Promise<CachedFile>
  /** Bytes of cached files. */
  usedBytes(): Promise<number>
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

export async function createLibraryCache(options: {
  /** Absolute directory owned by the Connector. */
  directory: string
  maxBytes: number
}): Promise<LibraryCache> {
  const { directory, maxBytes } = options
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('Invalid library cache size')
  const tmp = join(directory, TMP_DIR)
  await mkdir(tmp, { recursive: true, mode: 0o700 })
  const inUse = new Map<string, number>()
  // Downloads and eviction run one at a time: the size cap stays exact.
  let chain: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const run = chain.then(action, action)
    chain = run.catch(() => {})
    return run
  }

  async function entries() {
    const found: { sha256: string; size: number; mtimeMs: number }[] = []
    for (const name of await readdir(directory)) {
      if (!SHA256.test(name)) continue
      const info = await stat(join(directory, name)).catch(() => null)
      if (info?.isFile())
        found.push({ sha256: name, size: info.size, mtimeMs: info.mtimeMs })
    }
    return found
  }
  const drop = (sha256: string) =>
    unlink(join(directory, sha256)).catch((error: unknown) => {
      if (!missing(error)) throw error
    })

  /** Evicts the least recently used idle files until `needed` more bytes fit. */
  async function makeRoom(needed: number, keep: string): Promise<boolean> {
    const stored = await entries()
    let used = stored.reduce((sum, file) => sum + file.size, 0)
    for (const file of stored.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (used + needed <= maxBytes) return true
      if (file.sha256 === keep || inUse.has(file.sha256)) continue
      await drop(file.sha256)
      used -= file.size
    }
    return used + needed <= maxBytes
  }

  function lease(sha256: string, size: number, reused: boolean): CachedFile {
    inUse.set(sha256, (inUse.get(sha256) ?? 0) + 1)
    let released = false
    return {
      sha256,
      size,
      path: join(directory, sha256),
      reused,
      release() {
        if (released) return
        released = true
        const left = (inUse.get(sha256) ?? 1) - 1
        if (left > 0) inUse.set(sha256, left)
        else inUse.delete(sha256)
      },
    }
  }

  async function fetchInto(
    sha256: string,
    download: LibraryDownloader,
    signal: AbortSignal,
  ): Promise<CachedFile> {
    const cap = Math.min(maxBytes, MAX_FILE_SIZE)
    let source: LibraryDownload
    try {
      source = await download(sha256, signal)
    } catch {
      throw new LibraryCacheError('download-failed')
    }
    if (source.size !== undefined && source.size > cap)
      throw new LibraryCacheError('cache-full')
    const temp = join(tmp, randomUUID())
    const hash = createHash('sha256')
    let size = 0
    let overflow = false
    const meter = new Transform({
      transform(chunk: Uint8Array, _encoding, callback) {
        size += chunk.length
        if (size > cap) {
          overflow = true
          return callback(new Error('cache-full'))
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      try {
        await pipeline(
          source.stream,
          meter,
          createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
          { signal },
        )
      } catch {
        throw new LibraryCacheError(overflow ? 'cache-full' : 'download-failed')
      }
      if (hash.digest('hex') !== sha256)
        throw new LibraryCacheError('checksum-mismatch')
      if (!(await makeRoom(size, sha256)))
        throw new LibraryCacheError('cache-full')
      await rename(temp, join(directory, sha256))
      return lease(sha256, size, false)
    } finally {
      await unlink(temp).catch((error: unknown) => {
        if (!missing(error)) throw error
      })
    }
  }

  return {
    acquire(sha256, download, signal) {
      if (!SHA256.test(sha256))
        return Promise.reject(new LibraryCacheError('download-failed'))
      return exclusive(async () => {
        const path = join(directory, sha256)
        const info = await stat(path).catch(() => null)
        if (info?.isFile()) {
          if ((await hashFile(path)) === sha256) {
            const now = new Date()
            await utimes(path, now, now)
            return lease(sha256, info.size, true)
          }
          // A damaged copy is never used: fetch a fresh one over it.
          await drop(sha256)
        }
        return fetchInto(sha256, download, signal)
      })
    },
    async usedBytes() {
      return (await entries()).reduce((sum, file) => sum + file.size, 0)
    },
  }
}
