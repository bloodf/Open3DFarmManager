import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { MAX_FILE_SIZE } from '../../../farm-protocol/src/file-transfer.ts'
import {
  LIBRARY_DEFAULT_RETENTION_DAYS,
  LIBRARY_ORPHAN_GRACE_MS,
  LibraryVersionMeta,
  MAX_LIBRARY_LIST_ENTRIES,
  type LibraryFileEntryValue,
  type LibraryRemovalValue,
  type LibraryStorageReportValue,
  type LibraryVersionMetaValue,
} from '../../../farm-protocol/src/library-storage.ts'

/**
 * Connector-mode print library (#446): content-addressed files at
 * `<directory>/<sha256>`, atomic writes (fsync + rename), hash verification on
 * write and before every print start, dedupe by hash, and the same quota and
 * retention rules as the server library (#378). Only metadata, thumbnails and
 * hashes are ever listed to the server; file bytes stay on this host.
 */
export const DEFAULT_LIBRARY_QUOTA_BYTES = 21_474_836_480 // 20 GiB, as the server default
const DAY_MS = 86_400_000
const SHA256 = /^[0-9a-f]{64}$/
const TMP_DIR = '.tmp'
const INDEX_FILE = 'index.json'

export type LibraryStoreErrorCode =
  | 'disk-full'
  | 'quota-exceeded'
  | 'not-found'
  | 'hash-mismatch'
  | 'too-large'
  | 'invalid-hash'
  | 'invalid-directory'
  | 'index-unreadable'

const MESSAGES: Record<LibraryStoreErrorCode, string> = {
  'disk-full':
    'Disco cheio no computador do Conector: não há espaço para gravar o arquivo na biblioteca.',
  'quota-exceeded': 'Cota da biblioteca excedida no computador do Conector.',
  'not-found':
    'Arquivo não encontrado na biblioteca do Conector. Envie o arquivo novamente.',
  'hash-mismatch':
    'O arquivo não confere com o SHA-256 registrado e não será gravado nem impresso.',
  'too-large': 'O arquivo excede o tamanho máximo da biblioteca.',
  'invalid-hash': 'SHA-256 inválido.',
  'invalid-directory':
    'A pasta da biblioteca do Conector deve ser um caminho absoluto.',
  'index-unreadable':
    'O índice da biblioteca do Conector está ilegível. Nada foi alterado.',
}

export class LibraryStoreError extends Error {
  readonly code: LibraryStoreErrorCode
  /** Accessible pt-BR text, safe to show to the user. */
  readonly userMessage: string
  constructor(code: LibraryStoreErrorCode, detail?: string) {
    super(detail ?? code)
    this.name = 'LibraryStoreError'
    this.code = code
    this.userMessage = detail ?? MESSAGES[code]
  }
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const
function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${UNITS[unit]}`
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const VersionRecord = LibraryVersionMeta.extend({
  pinned: z.boolean(),
  /** Soft delete: still on disk until the retention window ends. */
  deleted_at: count.nullable(),
  /** Retention or quota removed the file; the row stays so replay shows it. */
  removed_at: count.nullable(),
})
type VersionRecordValue = z.infer<typeof VersionRecord>
const IndexFile = z.strictObject({
  version: z.literal(1),
  versions: z.array(VersionRecord),
})

export interface LibrarySettings {
  quotaBytes: number
  retentionDays: number
  /** Newest live versions kept per item; null keeps all. */
  keepVersions: number | null
}
export interface LibraryStoreOptions extends Partial<LibrarySettings> {
  /** Absolute path of the library directory on this host. */
  directory: string
  clock?: () => number
  /** Free bytes on the volume of `directory`. Default: `statfs`. */
  freeBytes?: (directory: string) => Promise<number>
}
export type VersionMeta = Omit<
  LibraryVersionMetaValue,
  'sha256' | 'size_bytes' | 'created_at'
> & { created_at?: number }
export interface PutOptions {
  /** Refuse (and drop the temp file) when the received bytes hash differently. */
  expectedSha256?: string
  /** Checked against free disk before the upload is accepted, and against the received size. */
  expectedSize?: number
  maxBytes?: number
  /** Registers a listed version for these bytes. */
  meta?: VersionMeta
  pinned?: boolean
  /** Remove the oldest unpinned versions when the file does not fit; default refuses. */
  evictToFit?: boolean
  /** Test seam: runs after fsync and before the rename. A throw simulates a crash. */
  beforeRename?: () => void | Promise<void>
}
export interface PutResult {
  sha256: string
  size: number
  /** A new file was written to disk. */
  created: boolean
  /** The same bytes were already stored intact: one copy is kept. */
  deduplicated: boolean
  /** A stored file with this hash was corrupt and has been replaced. */
  repaired: boolean
  /** Removed to make room (only with `evictToFit`). */
  evicted: LibraryRemovalValue[]
}
export interface VerifiedFile {
  sha256: string
  size: number
  /** Absolute path, valid for a print start right after verification. */
  path: string
}
export interface LibraryUsage {
  usedBytes: number
  quotaBytes: number
  availableBytes: number
}
export interface RetentionOutcome {
  /** Versions soft-deleted by "keep newest N". */
  trimmed: string[]
  removed: LibraryRemovalValue[]
}

export interface LibraryStore {
  put(
    source: AsyncIterable<Uint8Array>,
    options?: PutOptions,
  ): Promise<PutResult>
  has(sha256: string): Promise<boolean>
  /** Re-hashes the stored file. Throws `not-found` or `hash-mismatch`. */
  verify(sha256: string): Promise<VerifiedFile>
  /** The only way to reach a file for a print start: verifies first, every time. */
  openForPrint(sha256: string): Promise<VerifiedFile>
  /** Verified read stream (for sending the file somewhere on explicit request). */
  readVerified(
    sha256: string,
  ): Promise<{ size: number; stream: AsyncIterable<Uint8Array> }>
  /** Adds a listed version for a file already stored (dedupe: one copy, many versions). */
  link(sha256: string, meta: VersionMeta, pinned?: boolean): Promise<void>
  list(): Promise<LibraryFileEntryValue[]>
  usage(): Promise<LibraryUsage>
  report(): Promise<LibraryStorageReportValue>
  configure(settings: Partial<LibrarySettings>): void
  setPinned(versionId: string, pinned: boolean): Promise<boolean>
  softDelete(versionId: string): Promise<boolean>
  /** Quota lowered below usage: removes the oldest unpinned versions until it fits. */
  enforceQuota(): Promise<LibraryRemovalValue[]>
  /** Retention job on this host: keep-newest-N trim, window purge, orphan sweep. */
  applyRetention(): Promise<RetentionOutcome>
  /** Server-ordered purge. An absent file counts as removed. */
  purge(sha256s: readonly string[]): Promise<string[]>
  /** Removes unreferenced files older than the grace period; returns what it removed. */
  sweep(referenced: readonly string[]): Promise<string[]>
  /** Drops file and listing rows (the version moved to the server): no "removed" state. */
  release(sha256s: readonly string[]): Promise<string[]>
}

interface StoredFile {
  sha256: string
  size: number
  mtimeMs: number
}

const isCode = (error: unknown, ...codes: string[]) =>
  typeof error === 'object' &&
  error !== null &&
  codes.includes((error as NodeJS.ErrnoException).code ?? '')
const diskFull = (error: unknown): LibraryStoreError | null =>
  isCode(error, 'ENOSPC', 'EDQUOT') ? new LibraryStoreError('disk-full') : null

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function defaultFreeBytes(directory: string): Promise<number> {
  const info = await statfs(directory)
  return Number(info.bavail) * Number(info.bsize)
}

export async function createLibraryStore(
  options: LibraryStoreOptions,
): Promise<LibraryStore> {
  if (!options.directory || !isAbsolute(options.directory))
    throw new LibraryStoreError('invalid-directory')
  await mkdir(join(options.directory, TMP_DIR), {
    recursive: true,
    mode: 0o700,
  })
  const root = await realpath(resolve(options.directory))
  const tmp = join(root, TMP_DIR)
  const indexPath = join(root, INDEX_FILE)
  const clock = options.clock ?? Date.now
  const freeBytes = options.freeBytes ?? defaultFreeBytes
  let settings: LibrarySettings = {
    quotaBytes: options.quotaBytes ?? DEFAULT_LIBRARY_QUOTA_BYTES,
    retentionDays: options.retentionDays ?? LIBRARY_DEFAULT_RETENTION_DAYS,
    keepVersions: options.keepVersions ?? null,
  }

  const pathFor = (sha256: string): string => {
    if (!SHA256.test(sha256)) throw new LibraryStoreError('invalid-hash')
    const path = join(root, sha256)
    if (!path.startsWith(root + sep))
      throw new LibraryStoreError('invalid-hash')
    return path
  }
  const regularFile = async (path: string) => {
    const info = await lstat(path).catch(() => null)
    return info?.isFile() ? info : null
  }

  let versions: VersionRecordValue[] = []
  try {
    const raw = await readFile(indexPath, 'utf8').catch((error: unknown) => {
      if (isCode(error, 'ENOENT')) return null
      throw error
    })
    if (raw !== null) versions = IndexFile.parse(JSON.parse(raw)).versions
  } catch {
    throw new LibraryStoreError('index-unreadable')
  }

  /** Index writes are atomic too: temp file in the library temp dir, then rename. */
  async function saveIndex(): Promise<void> {
    const temp = join(tmp, randomUUID())
    try {
      await writeFile(temp, JSON.stringify({ version: 1, versions }), {
        mode: 0o600,
      })
      await rename(temp, indexPath)
    } catch (cause) {
      await unlink(temp).catch(() => {})
      throw diskFull(cause) ?? cause
    }
  }

  // One mutation at a time keeps quota accounting and the index exact.
  let chain: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const run = chain.then(action, action)
    chain = run.catch(() => {})
    return run
  }

  async function files(): Promise<StoredFile[]> {
    const found: StoredFile[] = []
    for (const name of await readdir(root)) {
      if (!SHA256.test(name)) continue
      const info = await regularFile(join(root, name))
      if (info)
        found.push({ sha256: name, size: info.size, mtimeMs: info.mtimeMs })
    }
    return found
  }
  const usedOf = (stored: readonly StoredFile[]) =>
    stored.reduce((sum, file) => sum + file.size, 0)

  const refsOf = (sha256: string) =>
    versions.filter((v) => v.sha256 === sha256 && v.removed_at === null)

  /** Removes the file and marks every version using it as removed; the caller saves the index. */
  async function removeBlob(
    sha256: string,
    reason: LibraryRemovalValue['reason'],
    now: number,
  ): Promise<LibraryRemovalValue> {
    const path = pathFor(sha256)
    const info = await regularFile(path)
    const refs = refsOf(sha256)
    if (info) await unlink(path)
    versions = versions.map((v) =>
      v.sha256 === sha256 && v.removed_at === null
        ? { ...v, removed_at: now }
        : v,
    )
    return {
      sha256,
      size_bytes: info?.size ?? refs[0]?.size_bytes ?? 0,
      version_ids: refs.map((v) => v.version_id),
      reason,
    }
  }

  const age = (stored: StoredFile) =>
    Math.min(stored.mtimeMs, ...refsOf(stored.sha256).map((v) => v.created_at))

  /** Oldest unpinned files first; null when even removing all of them cannot make room. */
  function evictionPlan(
    stored: readonly StoredFile[],
    needed: number,
    exclude?: string,
  ): StoredFile[] | null {
    let over = usedOf(stored) + needed - settings.quotaBytes
    if (over <= 0) return []
    const plan: StoredFile[] = []
    const candidates = stored
      .filter(
        (file) =>
          file.sha256 !== exclude &&
          !versions.some((v) => v.sha256 === file.sha256 && v.pinned),
      )
      .sort((a, b) => age(a) - age(b))
    for (const file of candidates) {
      plan.push(file)
      over -= file.size
      if (over <= 0) return plan
    }
    return null
  }

  async function evictPlan(
    plan: readonly StoredFile[],
    now: number,
  ): Promise<LibraryRemovalValue[]> {
    const removed: LibraryRemovalValue[] = []
    for (const file of plan)
      removed.push(await removeBlob(file.sha256, 'quota', now))
    if (removed.length > 0) await saveIndex()
    return removed
  }

  async function verifyFile(sha256: string): Promise<VerifiedFile> {
    const path = pathFor(sha256)
    const info = await regularFile(path)
    if (!info) throw new LibraryStoreError('not-found')
    if ((await hashFile(path)) !== sha256)
      throw new LibraryStoreError('hash-mismatch')
    return { sha256, size: info.size, path }
  }

  async function usage(): Promise<LibraryUsage> {
    const usedBytes = usedOf(await files())
    return {
      usedBytes,
      quotaBytes: settings.quotaBytes,
      availableBytes: Math.max(0, settings.quotaBytes - usedBytes),
    }
  }

  async function put(
    source: AsyncIterable<Uint8Array>,
    opts: PutOptions = {},
  ): Promise<PutResult> {
    if (opts.expectedSha256 !== undefined && !SHA256.test(opts.expectedSha256))
      throw new LibraryStoreError('invalid-hash')
    if (opts.expectedSize !== undefined) {
      // Refuse before accepting a byte when the volume cannot hold the file.
      if ((await freeBytes(root)) < opts.expectedSize)
        throw new LibraryStoreError('disk-full')
    }
    const maxBytes = Math.min(opts.maxBytes ?? MAX_FILE_SIZE, MAX_FILE_SIZE)
    const temp = join(tmp, randomUUID())
    const hash = createHash('sha256')
    let size = 0
    try {
      const handle = await open(temp, 'wx', 0o600)
      try {
        for await (const chunk of source) {
          size += chunk.byteLength
          if (size > maxBytes) throw new LibraryStoreError('too-large')
          if (opts.expectedSize !== undefined && size > opts.expectedSize)
            throw new LibraryStoreError('hash-mismatch')
          hash.update(chunk)
          await handle.write(chunk)
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
      const sha256 = hash.digest('hex')
      if (
        (opts.expectedSha256 !== undefined && sha256 !== opts.expectedSha256) ||
        (opts.expectedSize !== undefined && size !== opts.expectedSize)
      )
        throw new LibraryStoreError('hash-mismatch')
      return await exclusive(() => commit(temp, sha256, size, opts))
    } catch (cause) {
      await unlink(temp).catch(() => {})
      throw diskFull(cause) ?? cause
    }
  }

  function register(
    meta: VersionMeta,
    sha256: string,
    size: number,
    pinned: boolean,
    now: number,
  ): void {
    const record: VersionRecordValue = {
      ...meta,
      sha256,
      size_bytes: size,
      created_at: meta.created_at ?? now,
      pinned,
      deleted_at: null,
      removed_at: null,
    }
    versions = [
      ...versions.filter((v) => v.version_id !== meta.version_id),
      record,
    ]
  }

  /** Runs under the lock: dedupe, repair, quota, rename, index. The temp file is already verified. */
  async function commit(
    temp: string,
    sha256: string,
    size: number,
    opts: PutOptions,
  ): Promise<PutResult> {
    const now = clock()
    const target = pathFor(sha256)
    const stored = await files()
    let deduplicated = false
    let repaired = false
    let evicted: LibraryRemovalValue[] = []
    if (stored.some((file) => file.sha256 === sha256)) {
      // Dedupe only on an intact copy; a corrupt one is replaced by the verified bytes.
      deduplicated = (await hashFile(target).catch(() => '')) === sha256
      repaired = !deduplicated
    }
    if (deduplicated) await unlink(temp)
    else {
      const others = stored.filter((file) => file.sha256 !== sha256)
      const plan = evictionPlan(others, size, sha256)
      const fits = usedOf(others) + size <= settings.quotaBytes
      if (!fits) {
        if (!opts.evictToFit || plan === null) {
          const available = Math.max(0, settings.quotaBytes - usedOf(others))
          throw new LibraryStoreError(
            'quota-exceeded',
            `Cota da biblioteca excedida no computador do Conector: o envio precisa de ${formatBytes(size)}, mas há ${formatBytes(available)} livres de ${formatBytes(settings.quotaBytes)}. Remova versões antigas ou aumente a cota.`,
          )
        }
        evicted = await evictPlan(plan, now)
      }
      await opts.beforeRename?.()
      await rename(temp, target)
      const dir = await open(root, 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    }
    // The same bytes uploaded again restore versions retention had removed.
    versions = versions.map((v) =>
      v.sha256 === sha256 && v.removed_at !== null
        ? { ...v, removed_at: null, deleted_at: null }
        : v,
    )
    if (opts.meta) register(opts.meta, sha256, size, opts.pinned ?? false, now)
    await saveIndex()
    return {
      sha256,
      size,
      created: !deduplicated,
      deduplicated,
      repaired,
      evicted,
    }
  }

  async function removeMany(
    shas: readonly string[],
    reason: LibraryRemovalValue['reason'],
  ): Promise<LibraryRemovalValue[]> {
    const now = clock()
    const removed: LibraryRemovalValue[] = []
    for (const sha256 of shas)
      removed.push(await removeBlob(sha256, reason, now))
    if (removed.length > 0) await saveIndex()
    return removed
  }

  return {
    put,
    async has(sha256) {
      return (await regularFile(pathFor(sha256))) !== null
    },
    verify: verifyFile,
    openForPrint: verifyFile,
    async readVerified(sha256) {
      const file = await verifyFile(sha256)
      return { size: file.size, stream: createReadStream(file.path) }
    },

    link(sha256, meta, pinned = false) {
      return exclusive(async () => {
        const file = await regularFile(pathFor(sha256))
        if (!file) throw new LibraryStoreError('not-found')
        register(meta, sha256, file.size, pinned, clock())
        await saveIndex()
      })
    },

    async list() {
      const present = new Set((await files()).map((file) => file.sha256))
      const ordered = [...versions].sort(
        (a, b) =>
          b.created_at - a.created_at ||
          a.version_id.localeCompare(b.version_id),
      )
      let thumbnails = 0
      return ordered.slice(0, MAX_LIBRARY_LIST_ENTRIES).map((v) => {
        const { deleted_at: _deleted, removed_at: removedAt, ...rest } = v
        const state =
          removedAt !== null
            ? ('removed' as const)
            : present.has(v.sha256)
              ? ('stored' as const)
              : ('missing' as const)
        // The wire allows 50 thumbnails per answer.
        const { thumbnail, ...withoutThumbnail } = rest
        const keep = thumbnail !== undefined && thumbnails < 50
        if (keep) thumbnails++
        return {
          ...withoutThumbnail,
          ...(keep ? { thumbnail } : {}),
          state,
        }
      })
    },

    usage,
    async report() {
      const current = await usage()
      return {
        type: 'library.storage.report' as const,
        quota_bytes: current.quotaBytes,
        used_bytes: current.usedBytes,
        retention_days: settings.retentionDays,
        keep_versions: settings.keepVersions,
        reported_at: clock(),
      }
    },

    configure(next) {
      settings = {
        quotaBytes: next.quotaBytes ?? settings.quotaBytes,
        retentionDays: next.retentionDays ?? settings.retentionDays,
        keepVersions:
          next.keepVersions === undefined
            ? settings.keepVersions
            : next.keepVersions,
      }
    },

    setPinned(versionId, pinned) {
      return exclusive(async () => {
        if (!versions.some((v) => v.version_id === versionId)) return false
        versions = versions.map((v) =>
          v.version_id === versionId ? { ...v, pinned } : v,
        )
        await saveIndex()
        return true
      })
    },

    softDelete(versionId) {
      return exclusive(async () => {
        const target = versions.find(
          (v) => v.version_id === versionId && v.deleted_at === null,
        )
        if (!target) return false
        const now = clock()
        versions = versions.map((v) =>
          v.version_id === versionId ? { ...v, deleted_at: now } : v,
        )
        await saveIndex()
        return true
      })
    },

    enforceQuota() {
      return exclusive(async () => {
        // ponytail: when pinned files alone exceed the quota nothing is evicted; the next upload is refused.
        return evictPlan(evictionPlan(await files(), 0) ?? [], clock())
      })
    },

    applyRetention() {
      return exclusive(async () => {
        const now = clock()
        const trimmed: string[] = []
        if (settings.keepVersions !== null) {
          const live = new Map<string, VersionRecordValue[]>()
          for (const v of versions)
            if (v.deleted_at === null && v.removed_at === null)
              live.set(v.item_id, [...(live.get(v.item_id) ?? []), v])
          for (const group of live.values()) {
            group
              .sort((a, b) => b.version_number - a.version_number)
              .slice(settings.keepVersions)
              .filter((v) => !v.pinned)
              .forEach((v) => trimmed.push(v.version_id))
          }
          versions = versions.map((v) =>
            trimmed.includes(v.version_id) ? { ...v, deleted_at: now } : v,
          )
        }
        const doomed: {
          sha256: string
          reason: LibraryRemovalValue['reason']
        }[] = []
        for (const file of await files()) {
          const open = refsOf(file.sha256)
          if (open.length === 0) {
            if (now - file.mtimeMs >= LIBRARY_ORPHAN_GRACE_MS)
              doomed.push({ sha256: file.sha256, reason: 'orphan' })
          } else if (open.every((v) => v.deleted_at !== null && !v.pinned)) {
            const newest = Math.max(...open.map((v) => v.deleted_at ?? 0))
            if (newest <= now - settings.retentionDays * DAY_MS)
              doomed.push({ sha256: file.sha256, reason: 'retention' })
          }
        }
        const removed: LibraryRemovalValue[] = []
        for (const { sha256, reason } of doomed)
          removed.push(await removeBlob(sha256, reason, now))
        if (trimmed.length > 0 || removed.length > 0) await saveIndex()
        return { trimmed, removed }
      })
    },

    purge(sha256s) {
      return exclusive(async () => {
        const wanted = [...new Set(sha256s)]
        const removed = await removeMany(wanted, 'requested')
        const done = new Set(removed.map((r) => r.sha256))
        return wanted.filter((sha256) => done.has(sha256))
      })
    },

    sweep(referenced) {
      return exclusive(async () => {
        const keep = new Set(referenced)
        const now = clock()
        const stale = (await files())
          .filter(
            (file) =>
              !keep.has(file.sha256) &&
              now - file.mtimeMs >= LIBRARY_ORPHAN_GRACE_MS &&
              !versions.some((v) => v.sha256 === file.sha256 && v.pinned),
          )
          .map((file) => file.sha256)
        return (await removeMany(stale, 'orphan')).map((r) => r.sha256)
      })
    },

    release(sha256s) {
      return exclusive(async () => {
        const released: string[] = []
        for (const sha256 of new Set(sha256s)) {
          await unlink(pathFor(sha256)).catch((error: unknown) => {
            if (!isCode(error, 'ENOENT')) throw error
          })
          released.push(sha256)
        }
        versions = versions.filter((v) => !released.includes(v.sha256))
        await saveIndex()
        return released
      })
    },
  }
}
