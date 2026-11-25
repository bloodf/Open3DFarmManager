import {
  closeSync,
  fstatSync,
  type Stats,
  constants,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireQueueLock } from './queue-lock.ts'
import {
  DiscoveryResults,
  HeartbeatHealth,
  LegacyQueuedPrinterState,
  TelemetryEvent,
  PrinterState,
  PrinterTransition,
  SpoolInventory,
} from '@open3dfarmmanager/farm-protocol'

const MAX_BYTES = 50 * 1024 * 1024
const MAX_AGE = 24 * 60 * 60 * 1000
const MAX_RECORD = 64 * 1024
// Acknowledged prefix kept in the log before compaction reclaims it.
const COMPACT_BYTES = 8 * 1024 * 1024
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export type TelemetryRecord = TelemetryEvent
export interface QueueLimits {
  maxBytes?: number
  maxAgeMs?: number
  /** Acknowledged bytes tolerated in the log before compaction (256 to 8 MiB). */
  compactAfterBytes?: number
}
export type QueueOpeningPolicy = Readonly<{ beforeRecovery: () => undefined }>
export interface QueueLoss {
  expired: number
  capacity: number
  partialTail: boolean
}
// Errors that mean the disk, not the queue contents, is at fault. They degrade
// the queue instead of closing it: memory stays authoritative until a retry.
const STORAGE_CODES = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EROFS'])
const storageFault = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  STORAGE_CODES.has(String(error.code))
const emptyLoss = (): QueueLoss => ({
  expired: 0,
  capacity: 0,
  partialTail: false,
})
function privateEntry(path: string, directory = false) {
  privateStat(lstatSync(path), directory)
}
function privateStat(stat: Stats, directory = false) {
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new Error('Queue storage must use regular private files')
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
  )
    throw new Error(
      'Queue storage must be private and owned by the current user',
    )
}
function clock(now: number) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error('Invalid queue clock')
}
function parseRecord(value: unknown): TelemetryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid queue record')
  const record = value as Record<string, unknown>
  if (record.kind === 'discovery' || record.kind === 'heartbeat')
    return TelemetryEvent.parse(record)
  const transition = record.kind === 'printer-transition'
  const inventory = record.kind === 'inventory-snapshot'
  if (
    Object.keys(record).sort().join(',') !==
      (transition
        ? 'eventId,kind,queuedAt,transition'
        : inventory
          ? 'eventId,inventory,kind,queuedAt'
          : 'eventId,kind,queuedAt,state') ||
    typeof record.eventId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      record.eventId,
    ) ||
    (record.kind !== 'printer-state' && !transition && !inventory) ||
    typeof record.queuedAt !== 'number'
  )
    throw new Error('Invalid queue record')
  clock(record.queuedAt)
  if (transition)
    return {
      eventId: record.eventId,
      queuedAt: record.queuedAt,
      kind: 'printer-transition',
      transition: PrinterTransition.parse(record.transition),
    }
  if (inventory)
    return {
      eventId: record.eventId,
      queuedAt: record.queuedAt,
      kind: 'inventory-snapshot',
      inventory: SpoolInventory.parse(record.inventory),
    }
  return {
    eventId: record.eventId,
    queuedAt: record.queuedAt,
    kind: 'printer-state',
    state: LegacyQueuedPrinterState.parse(record.state),
  }
}
const line = (record: TelemetryRecord) => JSON.stringify(record) + '\n'
// Records are immutable once queued, so their serialized size is computed once.
const sizes = new WeakMap<TelemetryRecord, number>()
function size(record: TelemetryRecord) {
  let value = sizes.get(record)
  if (value === undefined)
    sizes.set(record, (value = Buffer.byteLength(line(record))))
  return value
}
const bytes = (records: readonly TelemetryRecord[]) =>
  records.reduce((total, record) => total + size(record), 0)

// Single-writer durable telemetry only. No commands, keys, credentials or network calls.
export class TelemetryQueue {
  private records: TelemetryRecord[] = []
  private readonly ageAnchors = new Map<
    string,
    { elapsed: number; monotonic: number }
  >()
  private readonly path: string
  private readonly lock: string
  private readonly temporary: string
  private readonly cursor: string
  private readonly cursorTemporary: string
  private readonly compactAfterBytes: number
  /** Bytes of acknowledged records still present at the head of the log. */
  private ackedBytes = 0
  private readonly maxBytes: number
  private readonly maxAgeMs: number
  private closed = false
  private failed = false
  /** Storage refused a write. Nothing is enqueued or batched until a retry succeeds. */
  private degraded = false
  private lost = 0
  private lastNow: number
  private readonly directory: string
  readonly recovery: QueueLoss
  /** True when this open took over a lock left by an owner that cannot be running. */
  readonly recoveredStaleLock: boolean
  /** Takeover succeeded but its recovery mutex could not be removed (operator review). */
  readonly recoveryMutexLeft: boolean

  constructor(
    directory: string,
    now: number,
    limits: QueueLimits = {},
    policy?: QueueOpeningPolicy,
  ) {
    clock(now)
    this.directory = directory
    this.lastNow = now
    this.maxBytes = limits.maxBytes ?? MAX_BYTES
    this.maxAgeMs = limits.maxAgeMs ?? MAX_AGE
    this.compactAfterBytes = limits.compactAfterBytes ?? COMPACT_BYTES
    if (
      !Number.isSafeInteger(this.compactAfterBytes) ||
      this.compactAfterBytes < 256 ||
      this.compactAfterBytes > COMPACT_BYTES ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 256 ||
      this.maxBytes > MAX_BYTES ||
      !Number.isSafeInteger(this.maxAgeMs) ||
      this.maxAgeMs < 1 ||
      this.maxAgeMs > MAX_AGE
    )
      throw new Error('Invalid queue limits')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    privateEntry(directory, true)
    this.path = join(directory, 'telemetry.jsonl')
    this.lock = join(directory, 'telemetry.lock')
    this.temporary = join(directory, 'telemetry.compact')
    this.cursor = join(directory, 'telemetry.ack')
    this.cursorTemporary = join(directory, 'telemetry.ack.tmp')
    const lock = acquireQueueLock(this.lock)
    this.recoveredStaleLock = lock.recovered
    this.recoveryMutexLeft = lock.mutexLeft === true
    try {
      if (policy) {
        const result: unknown = policy.beforeRecovery()
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {})
          throw new Error('Queue opening policy must return undefined')
        }
      }
      this.recovery = emptyLoss()
      if (!existsSync(this.path)) {
        if (lstatSync(this.temporary, { throwIfNoEntry: false }))
          throw new Error(
            'Missing queue log requires explicit recovery of compaction candidate',
          )
        const fd = openSync(this.path, 'wx', 0o600)
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        this.syncDirectory()
      }
      const readFd = openSync(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      let data: Buffer
      try {
        const stat = fstatSync(readFd)
        privateStat(stat)
        if (stat.size > MAX_BYTES + COMPACT_BYTES + 2 * MAX_RECORD)
          throw new Error('Queue file exceeds recovery limit')
        data = readFileSync(readFd)
      } finally {
        closeSync(readFd)
      }
      const end = data.lastIndexOf(10) + 1
      if (data.length - end > MAX_RECORD)
        throw new Error('Oversized partial queue record')
      const complete = data.subarray(0, end)
      const decoded = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(complete)
      const seen = new Set<string>()
      for (const raw of decoded.split('\n').slice(0, -1)) {
        if (!raw || Buffer.byteLength(raw) > MAX_RECORD)
          throw new Error('Invalid queue line')
        let decodedRecord: unknown
        try {
          decodedRecord = JSON.parse(raw)
        } catch {
          throw new Error('Invalid queue JSON')
        }
        const record = parseRecord(decodedRecord)
        if (JSON.stringify(record) !== raw)
          throw new Error('Noncanonical queue record')
        if (seen.has(record.eventId))
          throw new Error('Duplicate queue event ID')
        seen.add(record.eventId)
        if (record.queuedAt > now) throw new Error('Queue clock regressed')
        this.records.push(record)
      }
      // Records up to the cursor were acknowledged; an absent ID means a later
      // compaction already removed them, so every record in this log is live.
      const acknowledged = this.readCursor()
      const head = this.records.findIndex(
        (record) => record.eventId === acknowledged,
      )
      if (head >= 0) {
        this.ackedBytes = bytes(this.records.slice(0, head + 1))
        this.records = this.records.slice(head + 1)
      }
      // Validate the committed log before cleaning leftover compaction/cursor files.
      for (const leftover of [this.temporary, this.cursorTemporary]) {
        if (!existsSync(leftover)) continue
        privateEntry(leftover)
        if (lstatSync(leftover).size > MAX_BYTES + COMPACT_BYTES)
          throw new Error('Oversized queue compaction file')
        unlinkSync(leftover)
        this.syncDirectory()
      }
      // Only an unterminated tail may be torn. Complete corrupt lines are never discarded.
      if (end !== data.length) {
        const fd = openSync(
          this.path,
          constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        try {
          privateStat(fstatSync(fd))
          ftruncateSync(fd, end)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        this.recovery.partialTail = true
      }
      const bounded = this.bound(this.records, now)
      Object.assign(this.recovery, bounded.loss)
      this.recovery.partialTail = end !== data.length
      if (
        bounded.records.length !== this.records.length ||
        this.ackedBytes >= this.compactAfterBytes
      )
        this.replace(bounded.records)
    } catch (error) {
      unlinkSync(this.lock)
      throw error
    }
  }
  private readCursor(): string | undefined {
    if (!lstatSync(this.cursor, { throwIfNoEntry: false })) return undefined
    privateEntry(this.cursor)
    const fd = openSync(
      this.cursor,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    let text: string
    try {
      const stat = fstatSync(fd)
      privateStat(stat)
      if (stat.size > 256)
        throw new Error('Invalid queue acknowledgement cursor')
      text = readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new Error('Invalid queue acknowledgement cursor')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).join(',') !== 'lastAcked' ||
      !('lastAcked' in value) ||
      typeof value.lastAcked !== 'string' ||
      !UUID.test(value.lastAcked)
    )
      throw new Error('Invalid queue acknowledgement cursor')
    return value.lastAcked
  }
  /** Durable acknowledgement without rewriting the log: temporary, fsync, rename. */
  private writeCursor(lastAcked: string) {
    const fd = openSync(this.cursorTemporary, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ lastAcked }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(this.cursorTemporary, this.cursor)
    this.syncDirectory()
  }
  private syncDirectory() {
    const fd = openSync(this.directory, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  /** Classifies a write failure: storage faults degrade, anything else fails closed. */
  private fault(error: unknown) {
    if (storageFault(error)) this.degraded = true
    else this.failed = true
  }
  /** True while storage refuses writes; see `retryStorage`. */
  get storageDegraded(): boolean {
    return this.degraded
  }
  /** Records dropped because storage was degraded when they were observed. */
  get storageLost(): number {
    return this.lost
  }
  /**
   * One bounded recovery attempt: rewrites the log from the in-memory records,
   * which include every acknowledgement accepted while degraded. Returns false
   * while storage still refuses writes. Other failures close the queue.
   */
  retryStorage(): boolean {
    if (this.closed || this.failed)
      throw new Error('Queue is closed or requires recovery')
    if (!this.degraded) return true
    try {
      for (const leftover of [this.temporary, this.cursorTemporary])
        if (lstatSync(leftover, { throwIfNoEntry: false })) unlinkSync(leftover)
      this.degraded = false
      this.replace(this.records)
      return true
    } catch (error) {
      this.fault(error)
      if (this.failed) throw error
      return false
    }
  }
  private ready(now: number, whileDegraded = false) {
    if (this.closed || this.failed)
      throw new Error('Queue is closed or requires recovery')
    if (this.degraded && !whileDegraded)
      throw new Error('Queue storage is degraded')
    clock(now)
    if (now < this.lastNow) throw new Error('Queue clock regressed')
    this.lastNow = now
  }
  private bound(records: TelemetryRecord[], now: number) {
    const loss = emptyLoss()
    let retained = records.filter((record) => {
      const expired = now - record.queuedAt >= this.maxAgeMs
      if (expired) loss.expired++
      return !expired
    })
    let total = bytes(retained)
    let offset = 0
    while (total > this.maxBytes && offset < retained.length) {
      total -= size(retained[offset++]!)
      loss.capacity++
    }
    retained = retained.slice(offset)
    return { records: retained, loss }
  }
  private replace(records: TelemetryRecord[]) {
    const temporary = this.temporary
    let created = false
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      created = true
      try {
        writeFileSync(fd, records.map(line).join(''))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, this.path)
      this.syncDirectory()
      this.records = records
      this.ackedBytes = 0
    } catch (error) {
      this.fault(error)
      throw error
    } finally {
      if (created && existsSync(temporary)) unlinkSync(temporary)
    }
  }
  enqueue(
    state: PrinterState,
    now: number,
  ): { eventId: string; loss: QueueLoss } {
    return this.append(
      { kind: 'printer-state', state: PrinterState.parse(state) },
      now,
    )
  }
  enqueueTransition(
    transition: PrinterTransition,
    now: number,
  ): { eventId: string; loss: QueueLoss } {
    return this.append(
      {
        kind: 'printer-transition',
        transition: PrinterTransition.parse(transition),
      },
      now,
    )
  }
  enqueueInventory(
    inventory: SpoolInventory,
    now: number,
  ): { eventId: string; loss: QueueLoss } {
    return this.append(
      {
        kind: 'inventory-snapshot',
        inventory: SpoolInventory.parse(inventory),
      },
      now,
    )
  }
  enqueueDiscovery(discovery: DiscoveryResults, now: number) {
    return this.append(
      { kind: 'discovery', discovery: DiscoveryResults.parse(discovery) },
      now,
    )
  }
  enqueueHeartbeat(health: HeartbeatHealth, now: number) {
    return this.append(
      { kind: 'heartbeat', health: HeartbeatHealth.parse(health) },
      now,
    )
  }
  private append(
    body:
      | { kind: 'printer-state'; state: PrinterState }
      | { kind: 'printer-transition'; transition: PrinterTransition }
      | { kind: 'inventory-snapshot'; inventory: SpoolInventory }
      | { kind: 'discovery'; discovery: DiscoveryResults }
      | { kind: 'heartbeat'; health: HeartbeatHealth },
    now: number,
  ): { eventId: string; loss: QueueLoss } {
    // Degraded storage stops enqueueing: the record is counted, never stored.
    const dropped = () => {
      this.lost++
      return { eventId: randomUUID(), loss: emptyLoss() }
    }
    if (this.degraded && !this.closed && !this.failed) return dropped()
    this.ready(now)
    const record: TelemetryRecord = {
      eventId: randomUUID(),
      queuedAt: now,
      ...body,
    }
    const queuedMonotonic = performance.now()
    const serialized = line(record)
    if (Buffer.byteLength(serialized) > Math.min(MAX_RECORD, this.maxBytes))
      throw new Error('Queue record exceeds size limit')
    const bounded = this.bound([...this.records, record], now)
    if (bounded.loss.expired || bounded.loss.capacity) {
      try {
        this.replace(bounded.records)
      } catch (error) {
        if (!this.degraded || this.failed) throw error
        return dropped()
      }
    } else {
      try {
        const fd = openSync(
          this.path,
          constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
        )
        try {
          privateStat(fstatSync(fd))
          const data = Buffer.from(serialized)
          let written = 0
          while (written < data.length) {
            const count = writeSync(fd, data, written, data.length - written)
            if (count <= 0) throw new Error('Queue append made no progress')
            written += count
          }
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        this.records.push(record)
      } catch (error) {
        this.fault(error)
        if (this.failed) throw error
        // A torn tail left by this write is rewritten by `retryStorage`.
        return dropped()
      }
    }
    const observedAt =
      body.kind === 'printer-state'
        ? body.state.observedAt
        : body.kind === 'inventory-snapshot'
          ? body.inventory.observedAt
          : now
    if (observedAt <= now)
      this.ageAnchors.set(record.eventId, {
        elapsed: now - observedAt,
        monotonic: queuedMonotonic,
      })
    this.pruneAgeAnchors()
    return { eventId: record.eventId, loss: bounded.loss }
  }
  private pruneAgeAnchors() {
    const live = new Set(this.records.map((record) => record.eventId))
    for (const id of this.ageAnchors.keys())
      if (!live.has(id)) this.ageAnchors.delete(id)
  }
  /** Recovered records lack a trustworthy monotonic anchor and cannot prove freshness. */
  sendAge(record: TelemetryRecord, now: number): number | undefined {
    const anchor = this.ageAnchors.get(record.eventId)
    if (!anchor || record.queuedAt > now) return undefined
    const observedAt =
      record.kind === 'printer-state'
        ? record.state.observedAt
        : record.kind === 'inventory-snapshot'
          ? record.inventory.observedAt
          : now
    if (observedAt > now) return undefined
    return Math.max(
      now - Math.min(observedAt, record.queuedAt),
      anchor.elapsed +
        Math.floor(Math.max(0, performance.now() - anchor.monotonic)),
    )
  }
  batch(
    now: number,
    maxRecords = 100,
    maxBytes = MAX_RECORD,
  ): { records: TelemetryRecord[]; loss: QueueLoss } {
    this.ready(now)
    if (
      !Number.isSafeInteger(maxRecords) ||
      maxRecords < 1 ||
      maxRecords > 1000 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 2 ||
      maxBytes > MAX_RECORD
    )
      throw new Error('Invalid batch limits')
    const bounded = this.bound(this.records, now)
    if (bounded.loss.expired || bounded.loss.capacity)
      this.replace(bounded.records)
    this.pruneAgeAnchors()
    const latestHeartbeat = this.records.findLastIndex(
      (record) => record.kind === 'heartbeat',
    )
    if (latestHeartbeat >= 0) {
      const retained = this.records.filter(
        (record, index) =>
          record.kind !== 'heartbeat' || index === latestHeartbeat,
      )
      if (retained.length !== this.records.length) this.replace(retained)
    }
    const records: TelemetryRecord[] = []
    let size = 2 // JSON array brackets, with commas between entries.
    for (const record of this.records.slice(0, maxRecords)) {
      if (
        records.length &&
        (record.kind === 'discovery' ||
          record.kind === 'heartbeat' ||
          records[0]?.kind === 'discovery' ||
          records[0]?.kind === 'heartbeat')
      )
        break
      const extra =
        Buffer.byteLength(JSON.stringify(record)) + (records.length ? 1 : 0)
      if (size + extra > maxBytes) break
      records.push(structuredClone(record))
      size += extra
    }
    return { records, loss: bounded.loss }
  }
  acknowledge(eventIds: readonly string[], now: number): void {
    // A delivery in flight when storage degraded still settles in memory.
    this.ready(now, true)
    if (!Array.isArray(eventIds) || eventIds.length > this.records.length)
      throw new Error('Acknowledgement must match the current FIFO prefix')
    for (let index = 0; index < eventIds.length; index++) {
      if (
        !Object.hasOwn(eventIds, index) ||
        eventIds[index] !== this.records[index]!.eventId
      )
        throw new Error('Acknowledgement must match the current FIFO prefix')
    }
    if (!eventIds.length) return
    const rest = this.records.slice(eventIds.length)
    // On a storage fault the cursor advance stays in memory and is persisted
    // by `retryStorage`. A crash before then can replay the removed prefix.
    if (!this.degraded) {
      try {
        this.writeCursor(eventIds.at(-1)!)
      } catch (error) {
        this.fault(error)
        if (this.failed) throw error
      }
    }
    this.ackedBytes += bytes(this.records.slice(0, eventIds.length))
    this.records = rest
    this.pruneAgeAnchors()
    if (
      !this.degraded &&
      (this.ackedBytes >= this.compactAfterBytes || rest.length === 0)
    ) {
      try {
        this.replace(rest)
      } catch (error) {
        if (!this.degraded || this.failed) throw error
      }
    }
  }
  /** Remove a head that is locally known to be unencodable. */
  discardHead(now: number): void {
    const head = this.records[0]
    if (head) this.acknowledge([head.eventId], now)
  }
  get depth(): number {
    return this.records.length
  }
  close() {
    if (this.closed) return
    this.closed = true
    unlinkSync(this.lock)
    this.syncDirectory()
  }
}
