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
  awaitsCollection,
  confirmCollection,
  observeCompletedAttempt,
  type CollectionState,
} from './queue-collection.ts'

const identifier = z.string().min(1).max(256)
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
    confirm(printer: string, attempt: string): void {
      identifier.parse(attempt)
      save({
        ...printers,
        [printer]: confirmCollection(read(printer), attempt),
      })
    },
  }
}
