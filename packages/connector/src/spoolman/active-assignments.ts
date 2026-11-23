import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { z } from 'zod'

const Slot = z
  .string()
  .min(1)
  .max(32)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Invalid slot')

const PrinterKey = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    'Invalid printer key',
  )

const Assignment = z.strictObject({
  printerKey: PrinterKey,
  slot: Slot,
  spoolId: z.number().int().positive(),
})
export type ActiveSpoolAssignment = z.infer<typeof Assignment>

const Document = z.strictObject({
  version: z.literal(1),
  assignments: z.array(Assignment).max(2048),
})

function keyOf(printerKey: string, slot: string) {
  return `${printerKey}\0${slot}`
}

/**
 * Manual spool→tool assignments. Persisted as JSON so a Connector or farm
 * process restart keeps operator choices when Moonraker Spoolman is absent.
 */
export function createActiveSpoolAssignmentStore(path: string) {
  let cache: Map<string, ActiveSpoolAssignment> | undefined
  let mutationQueue: Promise<void> = Promise.resolve()

  function serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(mutation)
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function load(): Promise<Map<string, ActiveSpoolAssignment>> {
    if (cache) return cache
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = new Map()
        return cache
      }
      throw error
    }
    const parsed = Document.safeParse(JSON.parse(raw))
    if (!parsed.success)
      throw new Error('Invalid active spool assignments file')
    const next = new Map<string, ActiveSpoolAssignment>()
    for (const row of parsed.data.assignments) {
      next.set(keyOf(row.printerKey, row.slot), row)
    }
    cache = next
    return next
  }

  async function persist(map: Map<string, ActiveSpoolAssignment>) {
    const document = Document.parse({
      version: 1,
      assignments: [...map.values()],
    })
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify(document)}\n`, { mode: 0o600 })
    await rename(temp, path)
    cache = map
  }

  return {
    async list(): Promise<ActiveSpoolAssignment[]> {
      return [...(await load()).values()]
    },
    async listForPrinter(printerKey: string): Promise<ActiveSpoolAssignment[]> {
      const key = PrinterKey.parse(printerKey)
      return (await this.list()).filter((row) => row.printerKey === key)
    },
    async assign(input: ActiveSpoolAssignment): Promise<ActiveSpoolAssignment> {
      const row = Assignment.parse(input)
      return serializeMutation(async () => {
        const map = new Map(await load())
        map.set(keyOf(row.printerKey, row.slot), row)
        await persist(map)
        return row
      })
    },
    async clear(printerKey: string, slot: string): Promise<void> {
      const key = keyOf(PrinterKey.parse(printerKey), Slot.parse(slot))
      await serializeMutation(async () => {
        const map = new Map(await load())
        map.delete(key)
        await persist(map)
      })
    },
    /** Drop the in-memory cache so the next read reloads from disk (restart). */
    forget(): void {
      cache = undefined
    },
  }
}

export type ActiveSpoolAssignmentStore = ReturnType<
  typeof createActiveSpoolAssignmentStore
>
