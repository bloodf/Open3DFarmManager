import {
  closeSync,
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
import { PrinterState } from '@open3dfarmmanager/farm-protocol'

const MAX_BYTES = 50 * 1024 * 1024
const MAX_AGE = 24 * 60 * 60 * 1000
const MAX_RECORD = 64 * 1024
export interface TelemetryRecord {
  eventId: string
  queuedAt: number
  kind: 'printer-state'
  state: PrinterState
}
export interface QueueLimits {
  maxBytes?: number
  maxAgeMs?: number
}
export interface QueueLoss {
  expired: number
  capacity: number
  partialTail: boolean
}
const emptyLoss = (): QueueLoss => ({
  expired: 0,
  capacity: 0,
  partialTail: false,
})
function privateEntry(path: string, directory = false) {
  const stat = lstatSync(path)
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
  if (
    Object.keys(record).sort().join(',') !== 'eventId,kind,queuedAt,state' ||
    typeof record.eventId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      record.eventId,
    ) ||
    record.kind !== 'printer-state' ||
    typeof record.queuedAt !== 'number'
  )
    throw new Error('Invalid queue record')
  clock(record.queuedAt)
  return {
    eventId: record.eventId,
    queuedAt: record.queuedAt,
    kind: 'printer-state',
    state: PrinterState.parse(record.state),
  }
}
const line = (record: TelemetryRecord) => JSON.stringify(record) + '\n'
const bytes = (records: readonly TelemetryRecord[]) =>
  records.reduce((size, record) => size + Buffer.byteLength(line(record)), 0)

// Single-writer durable telemetry only. No commands, keys, credentials or network calls.
export class TelemetryQueue {
  private records: TelemetryRecord[] = []
  private readonly path: string
  private readonly lock: string
  private readonly maxBytes: number
  private readonly maxAgeMs: number
  private closed = false
  private failed = false
  private lastNow: number
  private readonly directory: string
  readonly recovery: QueueLoss

  constructor(directory: string, now: number, limits: QueueLimits = {}) {
    clock(now)
    this.directory = directory
    this.lastNow = now
    this.maxBytes = limits.maxBytes ?? MAX_BYTES
    this.maxAgeMs = limits.maxAgeMs ?? MAX_AGE
    if (
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
    const lockFd = openSync(this.lock, 'wx', 0o600)
    try {
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid }))
      fsyncSync(lockFd)
    } finally {
      closeSync(lockFd)
    }
    try {
      this.recovery = emptyLoss()
      if (!existsSync(this.path)) {
        const fd = openSync(this.path, 'wx', 0o600)
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        this.syncDirectory()
      }
      privateEntry(this.path)
      const size = lstatSync(this.path).size
      if (size > MAX_BYTES + MAX_RECORD)
        throw new Error('Queue file exceeds recovery limit')
      const data = readFileSync(this.path)
      const end = data.lastIndexOf(10) + 1
      const complete = data.subarray(0, end)
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(complete)
      const seen = new Set<string>()
      for (const raw of decoded.split('\n').slice(0, -1)) {
        if (!raw || Buffer.byteLength(raw) > MAX_RECORD)
          throw new Error('Invalid queue line')
        const record = parseRecord(JSON.parse(raw))
        if (JSON.stringify(record) !== raw)
          throw new Error('Noncanonical queue record')
        if (seen.has(record.eventId))
          throw new Error('Duplicate queue event ID')
        seen.add(record.eventId)
        if (record.queuedAt > now) throw new Error('Queue clock regressed')
        this.records.push(record)
      }
      // Only an unterminated tail may be torn. Complete corrupt lines are never discarded.
      if (end !== data.length) {
        const fd = openSync(this.path, 'r+')
        try {
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
      if (bounded.records.length !== this.records.length)
        this.replace(bounded.records)
    } catch (error) {
      unlinkSync(this.lock)
      throw error
    }
  }
  private syncDirectory() {
    const fd = openSync(this.directory, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  private ready(now: number) {
    if (this.closed || this.failed)
      throw new Error('Queue is closed or requires recovery')
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
    let size = bytes(retained)
    let offset = 0
    while (size > this.maxBytes && offset < retained.length) {
      size -= Buffer.byteLength(line(retained[offset++]!))
      loss.capacity++
    }
    retained = retained.slice(offset)
    return { records: retained, loss }
  }
  private replace(records: TelemetryRecord[]) {
    const temporary = join(this.directory, `telemetry-${randomUUID()}.tmp`)
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(fd, records.map(line).join(''))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, this.path)
      this.syncDirectory()
      this.records = records
    } catch (error) {
      this.failed = true
      throw error
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
  enqueue(
    state: PrinterState,
    now: number,
  ): { eventId: string; loss: QueueLoss } {
    this.ready(now)
    const record: TelemetryRecord = {
      eventId: randomUUID(),
      queuedAt: now,
      kind: 'printer-state',
      state: PrinterState.parse(state),
    }
    const serialized = line(record)
    if (Buffer.byteLength(serialized) > Math.min(MAX_RECORD, this.maxBytes))
      throw new Error('Queue record exceeds size limit')
    const bounded = this.bound([...this.records, record], now)
    if (bounded.loss.expired || bounded.loss.capacity)
      this.replace(bounded.records)
    else {
      try {
        const fd = openSync(this.path, 'a')
        try {
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
        this.failed = true
        throw error
      }
    }
    return { eventId: record.eventId, loss: bounded.loss }
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
    const records: TelemetryRecord[] = []
    let size = 2 // JSON array brackets, with commas between entries.
    for (const record of this.records.slice(0, maxRecords)) {
      const extra =
        Buffer.byteLength(JSON.stringify(record)) + (records.length ? 1 : 0)
      if (size + extra > maxBytes) break
      records.push(structuredClone(record))
      size += extra
    }
    return { records, loss: bounded.loss }
  }
  acknowledge(eventIds: readonly string[], now: number): void {
    this.ready(now)
    if (
      eventIds.length > this.records.length ||
      eventIds.some((id, index) => id !== this.records[index]!.eventId)
    )
      throw new Error('Acknowledgement must match the current FIFO prefix')
    if (eventIds.length) this.replace(this.records.slice(eventIds.length))
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
