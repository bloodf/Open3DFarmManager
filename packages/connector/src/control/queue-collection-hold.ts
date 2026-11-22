import {
  CollectionArguments,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import type { PauseDriver, PauseRpcResult } from './pause-dispatcher.ts'
import type { PrinterBinding } from './printer-binding.ts'
import type { QueueCollectionJournal } from './queue-collection-journal.ts'

/** Starts OpenFarm sends to a printer: each is held while the bed is occupied. */
export const COLLECTION_HELD_ACTIONS: ReadonlySet<ExtendedControlAction> =
  new Set(['start_print', 'start_library_print'])

function refused(message: string, awaiting: boolean): Error {
  return Object.assign(new Error(message), {
    refusal: 'state' as const,
    ...(awaiting ? { resultCode: 'awaiting-collection' as const } : {}),
  })
}

/**
 * Wraps a printer driver so OpenFarm never sends the next copy to a printer
 * whose last OpenFarm run is awaiting collection. The hold lives in the
 * Connector's durable journal: duplicate completion reports and restarts keep
 * it; only `confirm_collection` for that exact attempt releases it. A journal
 * that cannot be read or written refuses every start (fail closed).
 *
 * `confirm_collection` names the end time of the run the operator saw; it
 * collects every held attempt that ended then or earlier, never a later one.
 * It never reaches the printer: its single "send" is the journal write, done
 * synchronously on the guard's stack.
 */
export function withCollectionHold<D extends PauseDriver>(
  driver: D,
  config: {
    journal: QueueCollectionJournal
    printerKey(binding: PrinterBinding): string | undefined
    clock?: () => number
  },
): D {
  const execute = driver.execute?.bind(driver)
  if (!execute) return driver
  const wall = config.clock ?? Date.now
  const controls = (binding: PrinterBinding) =>
    driver.controls?.(binding) ?? (['pause'] as const)
  function held(key: string): boolean {
    try {
      return config.journal.blocked(key)
    } catch {
      return true
    }
  }
  return Object.freeze({
    ...driver,
    controls(binding: PrinterBinding): readonly ExtendedControlAction[] {
      const base = controls(binding)
      const key = config.printerKey(binding)
      let awaiting = false
      try {
        awaiting = key !== undefined && config.journal.awaiting(key).length > 0
      } catch {
        // Starts are refused anyway; a confirmation cannot be recorded.
      }
      // Advertised only while a run awaits collection: the live state tells
      // the operator which printers hold their next copy.
      return awaiting && !base.includes('confirm_collection')
        ? Object.freeze([...base, 'confirm_collection' as const])
        : base
    },
    async execute(
      action: ExtendedControlAction,
      args: Record<string, unknown>,
      request: Parameters<NonNullable<PauseDriver['execute']>>[2],
    ): Promise<PauseRpcResult> {
      const key = config.printerKey(request.binding)
      if (action === 'confirm_collection') {
        const parsed = CollectionArguments.safeParse(args)
        if (!parsed.success || key === undefined)
          throw refused('Invalid collection confirmation', false)
        if (!request.beforeSend()) return { acknowledged: false }
        try {
          config.journal.confirmThrough(key, Number(parsed.data.attempt))
        } catch {
          return { acknowledged: false }
        }
        return { acknowledged: true }
      }
      if (!COLLECTION_HELD_ACTIONS.has(action))
        return execute(action, args, request)
      if (key === undefined || held(key)) {
        let awaiting = false
        try {
          awaiting =
            key !== undefined && config.journal.awaiting(key).length > 0
        } catch {
          /* fail closed */
        }
        throw refused(
          awaiting
            ? 'Printer awaiting collection'
            : 'Printer start outcome uncertain',
          awaiting,
        )
      }
      return execute(action, args, {
        ...request,
        beforeSend() {
          if (!request.beforeSend() || held(key)) return false
          try {
            config.journal.dispatched(key, wall())
          } catch {
            throw refused('Collection journal unavailable', false)
          }
          return true
        },
      })
    },
  }) as D
}
