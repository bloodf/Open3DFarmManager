import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type LibraryVersion = {
  id: string
  itemId: string
  name: string
  sha256: string
  size: number
  modified: number
  pinned?: boolean
  thumbnail?: string
}

export type LibraryStoreOptions = {
  directory: string
  quotaBytes: number
  keepNewestPerItem?: number
  now?: () => number
}

export class LibraryStoreError extends Error {
  constructor(
    readonly reason: 'full-disk' | 'missing-file' | 'hash-mismatch' | 'invalid',
  ) {
    super(`Connector library: ${reason}`)
    this.name = 'LibraryStoreError'
  }
}

/** Content-addressed Connector storage. Metadata is kept in memory by the host session owner. */
export class ConnectorLibraryStore {
  private readonly versions = new Map<string, LibraryVersion>()
  private readonly pendingRemoved: string[] = []
  private readonly now: () => number

  constructor(private readonly options: LibraryStoreOptions) {
    if (!Number.isSafeInteger(options.quotaBytes) || options.quotaBytes < 0)
      throw new LibraryStoreError('invalid')
    this.now = options.now ?? Date.now
  }

  async put(
    input: Omit<LibraryVersion, 'sha256' | 'size' | 'modified'> & {
      bytes: Uint8Array
    },
  ): Promise<LibraryVersion> {
    const { bytes } = input
    if (!input.id || !input.itemId || !input.name || !bytes.byteLength)
      throw new LibraryStoreError('invalid')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const target = this.path(sha256)
    await mkdir(dirname(target), { recursive: true })
    if (!(await this.exists(target))) {
      const room = await this.makeRoom(bytes.byteLength, input.itemId)
      if (!room) throw new LibraryStoreError('full-disk')
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, bytes, { flag: 'wx' })
        const written = await readFile(temporary)
        if (digest(written) !== sha256)
          throw new LibraryStoreError('hash-mismatch')
        try {
          await rename(temporary, target)
        } catch (error) {
          if (!(await this.exists(target))) throw error
          await unlink(temporary).catch(() => {})
        }
      } catch (error) {
        await unlink(temporary).catch(() => {})
        if (error instanceof LibraryStoreError) throw error
        throw new LibraryStoreError('full-disk')
      }
    }
    const version: LibraryVersion = {
      id: input.id,
      itemId: input.itemId,
      name: input.name,
      sha256,
      size: bytes.byteLength,
      modified: this.now(),
      ...(input.pinned ? { pinned: true } : {}),
      ...(input.thumbnail ? { thumbnail: input.thumbnail } : {}),
    }
    this.versions.set(version.id, version)
    return { ...version }
  }

  async readForPrint(id: string): Promise<Buffer> {
    const version = this.versions.get(id)
    if (!version) throw new LibraryStoreError('missing-file')
    let bytes: Buffer
    try {
      bytes = await readFile(this.path(version.sha256))
    } catch {
      throw new LibraryStoreError('missing-file')
    }
    if (digest(bytes) !== version.sha256)
      throw new LibraryStoreError('hash-mismatch')
    return bytes
  }

  list(): LibraryVersion[] {
    return [...this.versions.values()].map((version) => ({ ...version }))
  }

  async report(): Promise<{
    usedBytes: number
    availableBytes: number
    removed: string[]
    files: LibraryVersion[]
  }> {
    this.pendingRemoved.push(...(await this.enforceRetention()))
    const unique = new Map(
      this.list().map((version) => [version.sha256, version.size]),
    )
    const usedBytes = [...unique.values()].reduce(
      (total, size) => total + size,
      0,
    )
    const removed = this.pendingRemoved.splice(0)
    return {
      usedBytes,
      availableBytes: Math.max(0, this.options.quotaBytes - usedBytes),
      removed,
      files: this.list(),
    }
  }

  /** Transfers versions by metadata and bytes over the caller's authenticated session. */
  async switchMode(
    target: 'server' | 'connector',
    session: {
      put(version: LibraryVersion, bytes: Uint8Array): Promise<void>
      get(version: LibraryVersion): Promise<Uint8Array>
      remove?(version: LibraryVersion): Promise<void>
    },
    sourceVersions: LibraryVersion[] = this.list(),
  ): Promise<{ moved: string[]; stayed: string[] }> {
    const moved: string[] = []
    const stayed: string[] = []
    for (const version of sourceVersions) {
      try {
        if (target === 'server') {
          const bytes = await this.readForPrint(version.id)
          await session.put(version, bytes)
          await unlink(this.path(version.sha256)).catch(() => {})
          this.versions.delete(version.id)
        } else {
          const bytes = await session.get(version)
          if (digest(bytes) !== version.sha256)
            throw new LibraryStoreError('hash-mismatch')
          await this.put({ ...version, bytes })
        }
        moved.push(version.id)
      } catch {
        stayed.push(version.id)
      }
    }
    return { moved, stayed }
  }

  private async makeRoom(incoming: number, itemId: string): Promise<boolean> {
    const quota = this.options.quotaBytes
    if (incoming > quota) return false
    const keep = this.options.keepNewestPerItem ?? Number.MAX_SAFE_INTEGER
    const removed = await this.enforceRetention(itemId, keep)
    void removed
    const unique = new Map(
      this.list().map((version) => [version.sha256, version.size]),
    )
    let used = [...unique.values()].reduce((total, size) => total + size, 0)
    const candidates = this.list()
      .filter((version) => !version.pinned)
      .sort((a, b) => a.modified - b.modified)
    while (used + incoming > quota && candidates.length) {
      const version = candidates.shift()!
      this.versions.delete(version.id)
      this.pendingRemoved.push(version.id)
      if (
        ![...this.versions.values()].some(
          (entry) => entry.sha256 === version.sha256,
        )
      ) {
        await unlink(this.path(version.sha256)).catch(() => {})
        used -= version.size
      }
    }
    return used + incoming <= quota
  }

  private async enforceRetention(
    itemId?: string,
    keep = this.options.keepNewestPerItem ?? Number.MAX_SAFE_INTEGER,
  ): Promise<string[]> {
    const removed: string[] = []
    const groups = new Map<string, LibraryVersion[]>()
    for (const version of this.list())
      if (!itemId || version.itemId === itemId)
        groups.set(version.itemId, [
          ...(groups.get(version.itemId) ?? []),
          version,
        ])
    for (const versions of groups.values()) {
      const unpinned = versions
        .filter((version) => !version.pinned)
        .sort((a, b) => b.modified - a.modified)
      for (const version of unpinned.slice(Math.max(0, keep))) {
        this.versions.delete(version.id)
        removed.push(version.id)
        this.pendingRemoved.push(version.id)
        if (
          ![...this.versions.values()].some(
            (entry) => entry.sha256 === version.sha256,
          )
        )
          await unlink(this.path(version.sha256)).catch(() => {})
      }
    }
    return removed
  }

  private path(hash: string): string {
    return join(this.options.directory, hash.slice(0, 2), hash.slice(2))
  }
  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
