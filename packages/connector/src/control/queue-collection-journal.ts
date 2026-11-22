import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  awaitingAttempts,
  awaitsCollection,
  confirmCollection,
  confirmCollectionThrough,
  observeCompletedAttempt,
  observeDispatch,
  observeFinishedRun,
  type CollectionState,
} from './queue-collection.ts'

const identifier = z.string().min(1).max(256)
/** Oldest attempts beyond this many collected ones are dropped from the file. */
const KEEP_COLLECTED = 100
function trim(state: CollectionState): CollectionState {
  const collected = state.attempts.filter((a) => a.status === 'collected')
  if (collected.length <= KEEP_COLLECTED) return state
  const drop = new Set(
    collected.slice(0, collected.length - KEEP_COLLECTED).map((a) => a.id),
  )
  return { ...state, attempts: state.attempts.filter((a) => !drop.has(a.id)) }
}
const Document = z.strictObject({
  version: z.literal(1),
  printers: z
    .record(
      identifier,
      z.strictObject({
        attempts: z
          .array(
            z.strictObject({
              id: identifier,
              status: z.enum(['awaiting-collection', 'collected']),
            }),
          )
          .max(20000),
        dispatchedAt: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      }),
    )
    .refine((printers) => Object.keys(printers).length <= 1000),
})

/** Durable collection state. Failure to read or write must refuse queue starts. */
export function openQueueCollectionJournal(path: string) {
  mkdirSync(dirname(path), { recursive: true })
  const data = existsSync(path)
    ? Document.parse(JSON.parse(readFileSync(path, 'utf8')))
    : { version: 1 as const, printers: {} as Record<string, CollectionState> }
  let printers: Record<string, CollectionState> = data.printers
  let failed = false
  function save(next: Record<string, CollectionState>) {
    if (failed) throw new Error('Collection journal unavailable')
    const document = Document.parse({ version: 1, printers: next })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(document))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, path)
      const directory = openSync(dirname(path), 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
      printers = document.printers
    } catch (error) {
      failed = true
      throw error
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
  function read(printer: string): CollectionState {
    if (failed) throw new Error('Collection journal unavailable')
    identifier.parse(printer)
    return Object.hasOwn(printers, printer)
      ? printers[printer]!
      : { attempts: [] }
  }
  return {
    read(printer: string): CollectionState {
      return structuredClone(read(printer))
    },
    blocked(printer: string): boolean {
      return awaitsCollection(read(printer))
    },
    complete(printer: string, attempt: string): void {
      identifier.parse(attempt)
      const current = read(printer)
      const next = observeCompletedAttempt(current, attempt)
      if (next !== current) save({ ...printers, [printer]: next })
    },
    awaiting(printer: string): readonly string[] {
      return awaitingAttempts(read(printer))
    },
    /** Durably records an OpenFarm start before it is sent. */
    dispatched(printer: string, wallMs: number): void {
      save({ ...printers, [printer]: observeDispatch(read(printer), wallMs) })
    },
    /** Called for every observed finished run; repeats are no-ops. */
    finished(printer: string, endedAt: number): void {
      const current = read(printer)
      const next = observeFinishedRun(current, endedAt)
      if (next !== current) save({ ...printers, [printer]: next })
    },
    /** Idempotent: confirming an already collected attempt changes nothing. */
    confirm(printer: string, attempt: string): void {
      identifier.parse(attempt)
      const current = read(printer)
      const next = confirmCollection(current, attempt)
      if (
        current.attempts.find((entry) => entry.id === attempt)?.status ===
        'collected'
      )
        return
      save({ ...printers, [printer]: trim(next) })
    },
    /** Collects every awaiting attempt that ended at or before `endedAt`; returns how many. */
    confirmThrough(printer: string, endedAt: number): number {
      const current = read(printer)
      const before = awaitingAttempts(current).length
      const next = confirmCollectionThrough(current, endedAt)
      const released = before - awaitingAttempts(next).length
      if (released > 0) save({ ...printers, [printer]: trim(next) })
      return released
    },
  }
}
export type QueueCollectionJournal = ReturnType<
  typeof openQueueCollectionJournal
>

/** A journal that refuses everything: used when the file cannot be opened. */
export function unavailableQueueCollectionJournal(): QueueCollectionJournal {
  const fail = (): never => {
    throw new Error('Collection journal unavailable')
  }
  return {
    read: fail,
    blocked: fail,
    complete: fail,
    awaiting: fail,
    dispatched: fail,
    finished: fail,
    confirm: fail,
    confirmThrough: fail,
  }
}
