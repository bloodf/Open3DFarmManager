import type {
  FilamentUsage,
  PrinterState,
} from '@open3dfarmmanager/farm-protocol'
import type { ActiveSpoolAssignmentStore } from './active-assignments.ts'
import type {
  ActiveSpoolRef,
  FilamentRunAccounting,
  FilamentRunOutcome,
  RunCompletion,
} from './filament-run.ts'
import {
  MoonrakerSpoolmanAbsent,
  readMoonrakerActiveSpoolId,
} from '../moonraker/active-spool.ts'

/** Spools loaded on a printer right now. A rejection means "unknown". */
export type ActiveSpoolReader = (
  printerKey: string,
  signal: AbortSignal,
) => Promise<readonly ActiveSpoolRef[]>

/**
 * Moonraker's own `[spoolman]` spool wins: Moonraker already reports its usage
 * to Spoolman, so it is recorded only. Without one (no component, or no spool
 * selected) the operator's per-tool assignments apply. A Moonraker read that
 * fails for any other reason rejects: who tracks the spool is then unknown.
 */
export function createActiveSpoolReader(input: {
  moonraker: ReadonlyMap<
    string,
    Readonly<{ origin: string; headers(): Promise<Record<string, string>> }>
  >
  assignments: Pick<ActiveSpoolAssignmentStore, 'listForPrinter'>
  timeoutMs?: number
  fetch?: typeof fetch
}): ActiveSpoolReader {
  return async (printerKey, signal) => {
    const moonraker = input.moonraker.get(printerKey)
    if (moonraker) {
      try {
        const spoolId = await readMoonrakerActiveSpoolId({
          origin: moonraker.origin,
          headers: await moonraker.headers(),
          timeoutMs: input.timeoutMs ?? 5000,
          signal,
          ...(input.fetch ? { fetch: input.fetch } : {}),
        })
        if (spoolId !== null)
          return [{ tool: 'external', spoolId, source: 'moonraker' }]
      } catch (error) {
        if (!(error instanceof MoonrakerSpoolmanAbsent)) throw error
      }
    }
    return (await input.assignments.listForPrinter(printerKey)).map((row) => ({
      tool: row.slot,
      spoolId: row.spoolId,
      source: 'assignment',
    }))
  }
}

/** Measured usage only; a lone total length is attributed to a lone spool. */
function usageOf(
  job: NonNullable<PrinterState['lastJob']>,
  start: readonly ActiveSpoolRef[],
): readonly FilamentUsage[] | undefined {
  if (job.filamentUsage?.length) return job.filamentUsage
  const millimetres = job.filamentUsedMillimetres
  if (millimetres === undefined || millimetres <= 0) return undefined
  return [
    { tool: start.length === 1 ? start[0]!.tool : 'unknown', millimetres },
  ]
}

/**
 * Feeds every run the Connector watched start and finish into filament
 * accounting, once. A run that ended unwatched (before this process saw it
 * printing) is never accounted, so a restart cannot debit it again. Nothing
 * here retries: an uncertain debit stays uncertain in the journal.
 */
export function createFilamentRunTracker(input: {
  accounting: Pick<FilamentRunAccounting, 'completeRun'>
  readSpools: ActiveSpoolReader
  signal: AbortSignal
  onOutcome?: (printerKey: string, outcomes: FilamentRunOutcome[]) => void
  onError?: (printerKey: string, error: unknown) => void
}) {
  type Run = { startedAt: number; spools: Promise<readonly ActiveSpoolRef[]> }
  const runs = new Map<string, Run>()
  const chains = new Map<string, Promise<void>>()
  const work = new Set<Promise<void>>()
  const spoolsNow = (printerKey: string) =>
    input.readSpools(printerKey, input.signal).catch(() => [])

  function enqueue(printerKey: string, task: () => Promise<void>) {
    const next = (chains.get(printerKey) ?? Promise.resolve())
      .then(task)
      .catch((error: unknown) => {
        try {
          input.onError?.(printerKey, error)
        } catch {
          // A throwing sink never stops accounting or collection.
        }
      })
    chains.set(printerKey, next)
    work.add(next)
    void next.finally(() => {
      work.delete(next)
      if (chains.get(printerKey) === next) chains.delete(printerKey)
    })
  }

  return {
    /** Synchronous and never throws: called from the collection path. */
    observe(printer: Readonly<PrinterState>): void {
      if (input.signal.aborted) return
      const key = printer.printerKey
      if (printer.state === 'printing' || printer.state === 'paused') {
        if (!runs.has(key))
          runs.set(key, {
            startedAt: printer.observedAt,
            spools: spoolsNow(key),
          })
        return
      }
      const run = runs.get(key)
      const job = printer.lastJob
      if (!run || !job || job.endedAt < run.startedAt) return
      runs.delete(key)
      enqueue(key, async () => {
        const spoolsAtStart = await run.spools
        const spoolsAtEnd = await spoolsNow(key)
        // Never claim a run during shutdown: nothing has been sent for it.
        if (input.signal.aborted) return
        const usage = usageOf(job, spoolsAtStart)
        const completion: RunCompletion = {
          printerKey: key,
          endedAt: job.endedAt,
          outcome: job.outcome,
          ...(usage ? { usage } : {}),
          spoolsAtStart,
          spoolsAtEnd,
        }
        const outcomes = await input.accounting.completeRun(
          completion,
          input.signal,
        )
        input.onOutcome?.(key, outcomes)
      })
    },
    /** Resolves once every accepted completion has been journaled. */
    async idle(): Promise<void> {
      while (work.size) await Promise.all([...work])
    },
  }
}
export type FilamentRunTracker = ReturnType<typeof createFilamentRunTracker>
