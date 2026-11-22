import { z } from 'zod'

/**
 * Collection snapshot of a provisioning Connector: the committed runtime file
 * minus assignments whose server inventory acknowledgement is not durable yet.
 * It is the smallest mechanism that keeps every confirmed Moonraker/KobraLink
 * collector untouched while a new local commit waits for its confirmation. The
 * committed file itself is never edited here and no foreign assignment is
 * rewritten. The result is still validated by the strict runtime reader before
 * anything starts.
 */
const Loose = z.record(z.string(), z.unknown())
const Runtime = z.looseObject({
  version: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(6)]),
  collection: z.looseObject({
    version: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(6)]),
    printers: z.array(Loose).optional(),
    sdcp: z.strictObject({ printers: z.array(Loose) }).optional(),
    anycubic: z.strictObject({ printers: z.array(Loose) }).optional(),
    kobralink: z
      .looseObject({
        allowedOrigins: z.array(z.string()),
        printers: z.array(Loose),
      })
      .optional(),
  }),
  assignments: z.array(z.unknown()),
})

export function collectableRuntime(
  raw: unknown,
  unconfirmed: ReadonlySet<string>,
): Record<string, unknown> | null {
  const runtime = Runtime.parse(raw)
  const hidden = new Set<string>()
  const assignments = runtime.assignments.filter((value) => {
    if (typeof value !== 'object' || value === null) return true
    const id = Reflect.get(value, 'assignment_id')
    if (typeof id !== 'string' || !unconfirmed.has(id)) return true
    hidden.add(String(Reflect.get(value, 'printer_key')))
    return false
  })
  if (assignments.length === 0) return null
  if (hidden.size === 0) return { ...runtime }
  const moonrakerPrinters = runtime.collection.printers?.filter(
    (printer) => !hidden.has(String(printer.printerKey)),
  )
  const filteredCollection = {
    ...runtime.collection,
    ...(moonrakerPrinters ? { printers: moonrakerPrinters } : {}),
  }
  if (runtime.collection.sdcp) {
    const printers = runtime.collection.sdcp.printers.filter(
      (p) => !hidden.has(String(p.printerKey)),
    )
    if (printers.length)
      return {
        ...runtime,
        collection: { ...filteredCollection, sdcp: { printers } },
        assignments,
      }
    const { sdcp: _removed, ...collection } = filteredCollection
    return {
      ...runtime,
      version: 1,
      collection: { ...collection, version: 1 },
      assignments,
    }
  }
  if (runtime.collection.anycubic) {
    const printers = runtime.collection.anycubic.printers.filter(
      (p) => !hidden.has(String(p.printerKey)),
    )
    if (printers.length)
      return {
        ...runtime,
        collection: { ...filteredCollection, anycubic: { printers } },
        assignments,
      }
    const { anycubic: _removed, ...collection } = filteredCollection
    return {
      ...runtime,
      version: 1,
      collection: { ...collection, version: 1 },
      assignments,
    }
  }
  const kobralink = runtime.collection.kobralink
  const printers = (kobralink?.printers ?? []).filter(
    (printer) => !hidden.has(String(printer.printerKey)),
  )
  if (kobralink && printers.length > 0)
    return {
      ...runtime,
      collection: {
        ...filteredCollection,
        kobralink: { ...kobralink, printers },
      },
      assignments,
    }
  // No confirmed KobraLink printer remains: the collector reader requires a
  // version 1 collection without the KobraLink section in that case.
  const { kobralink: _removed, ...collection } = filteredCollection
  return {
    ...runtime,
    version: 1,
    collection: { ...collection, version: 1 },
    assignments,
  }
}
