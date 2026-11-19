import type { PrinterState } from '@open3dfarmmanager/farm-protocol'

/**
 * Remembers what a library start printed, so the finished job can be linked to
 * that library version (#385). Only in memory and only per printer: a job
 * started outside the library, or imported from printer history, never matches
 * and stays unlinked. The Connector adds `sha256` and `plate` to `lastJob`
 * itself; nothing is guessed from the file name alone.
 */
export interface LibraryJobStart {
  /** Name the file was uploaded under, as sent to `start_print`. */
  name: string
  sha256: string
  plate?: number
}

type LastJob = NonNullable<PrinterState['lastJob']>

/** Comparison ignores folders, case and extension: printers report their own spelling. */
const stem = (value: string) =>
  (value.split(/[\\/]/).pop() ?? value).replace(/\.[^.]*$/, '').toLowerCase()

const MAX_PRINTERS = 64
const RUNNING = new Set<PrinterState['state']>(['printing', 'paused'])

export function createLibraryJobLinks() {
  // `ran` flips once the printer is seen printing after the start, so the
  // previous job's repeated `lastJob` can never claim a newer start.
  const pending = new Map<string, LibraryJobStart & { ran: boolean }>()
  // `lastJob` repeats in every snapshot until the next print ends; the answer
  // for one end time must not change between repeats.
  const decided = new Map<
    string,
    { endedAt: number; link: Pick<LastJob, 'sha256' | 'plate'> }
  >()

  function bound<T>(map: Map<string, T>) {
    while (map.size > MAX_PRINTERS) map.delete(map.keys().next().value!)
  }

  return {
    /** Called after a library start reached the printer. A newer start replaces the older one. */
    remember(printerKey: string, start: LibraryJobStart) {
      pending.delete(printerKey)
      pending.set(printerKey, { ...start, ran: false })
      bound(pending)
    },
    /** Forget a start that never ran (refused or failed before printing). */
    forget(printerKey: string) {
      pending.delete(printerKey)
    },
    /**
     * Applied to every observed state before it is queued. Adds the link to a
     * finished job only when it is the one the library started.
     */
    attach(printer: PrinterState): PrinterState {
      const { printerKey, lastJob: last } = printer
      const start = pending.get(printerKey)
      if (RUNNING.has(printer.state)) {
        if (start) start.ran = true
        // A running printer still repeats the previous job: never link it.
        return printer
      }
      if (!last || last.sha256 !== undefined) return printer
      const known = decided.get(printerKey)
      if (known?.endedAt === last.endedAt)
        return { ...printer, lastJob: { ...last, ...known.link } }
      if (
        !start?.ran ||
        last.filename === undefined ||
        stem(last.filename) !== stem(start.name)
      )
        return printer
      pending.delete(printerKey)
      const link = {
        sha256: start.sha256,
        ...(start.plate === undefined ? {} : { plate: start.plate }),
      }
      decided.set(printerKey, { endedAt: last.endedAt, link })
      bound(decided)
      return { ...printer, lastJob: { ...last, ...link } }
    },
  }
}
export type LibraryJobLinks = ReturnType<typeof createLibraryJobLinks>
