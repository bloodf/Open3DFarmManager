import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** Server-mode library blobs: content-addressed files at `<root>/<sha256>`. */
const SHA256 = /^[0-9a-f]{64}$/
const TMP_DIR = '.tmp'

export interface PutResult {
  sha256: string
  size: number
  /** False when the same bytes were already stored: the temp file is dropped. */
  created: boolean
}
export interface PutOptions {
  /** Aborts the upload (and removes the temp file) beyond this many bytes. */
  maxBytes?: number
  /** Test seam: runs after fsync and before the rename. A throw simulates a crash. */
  beforeRename?: () => void | Promise<void>
}
export interface BlobRange {
  /** Inclusive byte offsets, already clamped to the blob size. */
  start: number
  end: number
}
export interface BlobRead {
  size: number
  range: BlobRange | null
  stream: ReadStream
}

export class BlobStoreError extends Error {
  readonly code:
    'invalid-hash' | 'outside-root' | 'not-found' | 'too-large' | 'bad-range'
  constructor(code: BlobStoreError['code'], message: string) {
    super(message)
    this.name = 'BlobStoreError'
    this.code = code
  }
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n`; a single range only. Null means satisfy whole blob. */
export function parseRange(
  header: string | undefined,
  size: number,
): BlobRange | null {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === ''))
    throw new BlobStoreError('bad-range', 'Unsupported range')
  let start: number
  let end: number
  if (match[1] === '') {
    const tail = Number(match[2])
    if (tail === 0) throw new BlobStoreError('bad-range', 'Unsatisfiable range')
    start = Math.max(0, size - tail)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    start >= size
  )
    throw new BlobStoreError('bad-range', 'Unsatisfiable range')
  return { start, end }
}

export interface BlobStore {
  put(
    source: AsyncIterable<Uint8Array>,
    options?: PutOptions,
  ): Promise<PutResult>
  has(sha256: string): Promise<boolean>
  read(sha256: string, range?: BlobRange | null): Promise<BlobRead>
  /** Removes temp files older than `olderThanMs` (leftovers of a crash before the rename). */
  sweepTemp(olderThanMs: number, now?: number): Promise<number>
  /** Removes one stored file. False when it was already absent. */
  remove(sha256: string): Promise<boolean>
  /** Stored files (temp files excluded) with size and last write time. */
  list(): Promise<{ sha256: string; size: number; mtimeMs: number }[]>
}

/**
 * `OPENFARM_LIBRARY_DIR` must be absolute. Every path is derived from a
 * validated hash, so nothing a caller supplies can leave the directory; symlinks
 * are refused as a second guard.
 */
export async function createBlobStore(
  directory: string | undefined,
): Promise<BlobStore> {
  if (!directory || !isAbsolute(directory))
    throw new BlobStoreError(
      'outside-root',
      'OPENFARM_LIBRARY_DIR must be an absolute path',
    )
  await mkdir(join(directory, TMP_DIR), { recursive: true, mode: 0o700 })
  const root = await realpath(resolve(directory))
  const tmp = join(root, TMP_DIR)

  const pathFor = (sha256: string): string => {
    if (!SHA256.test(sha256))
      throw new BlobStoreError('invalid-hash', 'Invalid hash')
    const path = join(root, sha256)
    if (!path.startsWith(root + sep))
      throw new BlobStoreError('outside-root', 'Path outside library')
    return path
  }
  const regularFile = async (path: string) => {
    const info = await lstat(path).catch(() => null)
    return info?.isFile() ? info : null
  }

  return {
    async put(source, options = {}) {
      const temp = join(tmp, randomUUID())
      const hash = createHash('sha256')
      let size = 0
      const handle = await open(temp, 'wx', 0o600)
      try {
        try {
          for await (const chunk of source) {
            size += chunk.byteLength
            if (options.maxBytes !== undefined && size > options.maxBytes)
              throw new BlobStoreError(
                'too-large',
                'Upload exceeds the size limit',
              )
            hash.update(chunk)
            await handle.write(chunk)
          }
          await handle.sync()
        } finally {
          await handle.close()
        }
        const sha256 = hash.digest('hex')
        const target = pathFor(sha256)
        await options.beforeRename?.()
        if (await regularFile(target)) {
          await unlink(temp)
          // A repeated upload restarts the orphan grace, so the retention sweep
          // cannot take an unreferenced file before its record is back.
          const now = new Date()
          await utimes(target, now, now)
          return { sha256, size, created: false }
        }
        await rename(temp, target)
        const dir = await open(root, 'r')
        try {
          await dir.sync()
        } finally {
          await dir.close()
        }
        return { sha256, size, created: true }
      } catch (cause) {
        await unlink(temp).catch(() => {})
        throw cause
      }
    },

    async has(sha256) {
      return (await regularFile(pathFor(sha256))) !== null
    },

    async read(sha256, range = null) {
      const path = pathFor(sha256)
      const info = await regularFile(path)
      if (!info) throw new BlobStoreError('not-found', 'Blob not found')
      if (
        range &&
        (range.start < 0 || range.end >= info.size || range.start > range.end)
      )
        throw new BlobStoreError('bad-range', 'Unsatisfiable range')
      return {
        size: info.size,
        range,
        stream: createReadStream(
          path,
          range ? { start: range.start, end: range.end } : {},
        ),
      }
    },

    async remove(sha256) {
      const path = pathFor(sha256)
      if (!(await regularFile(path))) return false
      await unlink(path)
      return true
    },

    async list() {
      const found: { sha256: string; size: number; mtimeMs: number }[] = []
      for (const name of await readdir(root)) {
        if (!SHA256.test(name)) continue
        const info = await regularFile(join(root, name))
        if (info)
          found.push({ sha256: name, size: info.size, mtimeMs: info.mtimeMs })
      }
      return found
    },

    async sweepTemp(olderThanMs, now = Date.now()) {
      let removed = 0
      for (const name of await readdir(tmp)) {
        const path = join(tmp, name)
        const info = await stat(path).catch(() => null)
        if (info?.isFile() && now - info.mtimeMs >= olderThanMs) {
          await unlink(path).catch(() => {})
          removed++
        }
      }
      return removed
    },
  }
}
