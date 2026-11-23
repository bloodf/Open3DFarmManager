import type { PrinterState } from '@open3dfarmmanager/farm-protocol'

/**
 * Adds the library hash and plate to a completed job using the pending
 * in-memory dispatch for that printer and its post-send telemetry.
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
const START_WINDOW_MS = 60_000
const RUNNING = new Set<PrinterState['state']>(['printing', 'paused'])

export function createLibraryJobLinks() {
  // `ran` flips once the printer is seen printing after the start, so the
  // previous job's repeated `lastJob` can never claim a newer start.
  const pending = new Map<
    string,
    LibraryJobStart & {
      ran: boolean
      sawRunning?: boolean
      stopped?: boolean
      previousEnd?: number
      observedAt?: number
      sentAt?: number
    }
  >()
  const latest = new Map<string, { observedAt: number; endedAt?: number }>()
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
    /** Called at the authorized write boundary, even if the acknowledgement is lost. */
    remember(printerKey: string, start: LibraryJobStart, sentAt?: number) {
      pending.delete(printerKey)
      const previousEnd = latest.get(printerKey)?.endedAt
      pending.set(printerKey, {
        ...start,
        ...(sentAt === undefined ? {} : { sentAt }),
        ran: false,
        ...(previousEnd === undefined ? {} : { previousEnd }),
      })
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
      const previous = latest.get(printerKey)
      if (!previous || printer.observedAt >= previous.observedAt) {
        const endedAt = Math.max(previous?.endedAt ?? -1, last?.endedAt ?? -1)
        latest.delete(printerKey)
        latest.set(printerKey, {
          observedAt: printer.observedAt,
          ...(endedAt >= 0 ? { endedAt } : {}),
        })
        bound(latest)
      }
      const running = RUNNING.has(printer.state)
      const known = decided.get(printerKey)
      const repeat =
        !running &&
        last &&
        last.sha256 === undefined &&
        known?.endedAt === last.endedAt
          ? { ...printer, lastJob: { ...last, ...known.link } }
          : printer
      if (!start) return repeat
      if (start.sentAt !== undefined) {
        if (
          printer.observedAt <= start.sentAt ||
          printer.observedAt <= (start.observedAt ?? -1) ||
          printer.observedAt < (previous?.observedAt ?? -1)
        )
          return repeat
        start.observedAt = printer.observedAt
        const newEnd =
          last !== undefined &&
          last.endedAt > Math.max(start.previousEnd ?? -1, start.sentAt)
        if (
          (!start.ran &&
            !newEnd &&
            printer.observedAt - start.sentAt > START_WINDOW_MS) ||
          (running && start.stopped) ||
          (running &&
            printer.filename &&
            stem(printer.filename) !== stem(start.name)) ||
          (!running && newEnd && last.sha256 !== undefined)
        ) {
          pending.delete(printerKey)
          return repeat
        }
        if (running) {
          start.sawRunning = true
          if (printer.filename && stem(printer.filename) === stem(start.name))
            start.ran = true
          return printer
        }
        if (!newEnd) {
          if (start.ran && printer.state === 'idle') start.stopped = true
          return repeat
        }
        // The first new terminal run consumes the attempt even if it cannot be linked.
        pending.delete(printerKey)
      } else if (running) {
        start.ran = true
        return printer
      }
      if (
        (!start.ran && (start.sentAt === undefined || start.sawRunning)) ||
        !last ||
        last.sha256 !== undefined ||
        last.filename === undefined ||
        stem(last.filename) !== stem(start.name)
      )
        return repeat
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
