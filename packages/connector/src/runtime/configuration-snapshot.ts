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
  version: z.union([z.literal(1), z.literal(2)]),
  collection: z.looseObject({
    version: z.union([z.literal(1), z.literal(2)]),
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
  const kobralink = runtime.collection.kobralink
  const printers = (kobralink?.printers ?? []).filter(
    (printer) => !hidden.has(String(printer.printerKey)),
  )
  if (kobralink && printers.length > 0)
    return {
      ...runtime,
      collection: {
        ...runtime.collection,
        kobralink: { ...kobralink, printers },
      },
      assignments,
    }
  // No confirmed KobraLink printer remains: the collector reader requires a
  // version 1 collection without the KobraLink section in that case.
  const { kobralink: _removed, ...collection } = runtime.collection
  return {
    ...runtime,
    version: 1,
    collection: { ...collection, version: 1 },
    assignments,
  }
}
