import { DriverRefusalError } from './driver-refusal.ts'
import {
  CollectionArguments,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import type { PauseDriver, PauseRpcResult } from './pause-dispatcher.ts'
import type { PrinterBinding } from './printer-binding.ts'
import { awaitsCollection } from './queue-collection.ts'
import {
  INITIAL_COLLECTION_ATTEMPT,
  type QueueCollectionJournal,
} from './queue-collection-journal.ts'

/** Starts OpenFarm sends to a printer: each is held while the bed is occupied. */
export const COLLECTION_HELD_ACTIONS: ReadonlySet<ExtendedControlAction> =
  new Set(['start_print', 'start_library_print'])

export type PlateStartRefusal = 'awaiting-collection' | 'plate-state-uncertain'

export interface PlateStartGuard {
  apiCollectionRefusal?: (
    binding: PrinterBinding,
    attempt: string,
  ) => string | null
  confirmApiCollection?: (binding: PrinterBinding, attempt: string) => void
  plateStartRefusal?: (binding: PrinterBinding) => PlateStartRefusal | null
}

function refused(message: string, awaiting: boolean): Error {
  return Object.assign(
    new DriverRefusalError('state', message),
    awaiting ? { resultCode: 'awaiting-collection' as const } : {},
  )
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
    /** Require a recorded clearance before the first supported API start. */
    requireInitialClearance?: (binding: PrinterBinding) => boolean
  },
): D & PlateStartGuard {
  const execute = driver.execute?.bind(driver)
  if (!execute) return driver
  const wall = config.clock ?? Date.now
  const controls = (binding: PrinterBinding) =>
    driver.controls?.(binding) ?? (['pause'] as const)
  function plateStartRefusal(
    binding: PrinterBinding,
  ): PlateStartRefusal | null {
    const key = config.printerKey(binding)
    if (key === undefined) return 'plate-state-uncertain'
    try {
      const state = config.journal.read(key)
      if (awaitsCollection(state)) return 'awaiting-collection'
      if (
        state.dispatchedAt !== undefined ||
        (state.attempts.length === 0 &&
          config.requireInitialClearance?.(binding))
      )
        return 'plate-state-uncertain'
      return null
    } catch {
      return 'plate-state-uncertain'
    }
  }
  return Object.freeze({
    ...driver,
    plateStartRefusal,
    apiCollectionRefusal(binding: PrinterBinding, attempt: string) {
      const key = config.printerKey(binding)
      if (key === undefined) return 'plate-state-uncertain'
      try {
        const state = config.journal.read(key)
        if (state.dispatchedAt !== undefined) return 'plate-state-uncertain'
        const current =
          state.attempts.findLast(
            (entry) => entry.status === 'awaiting-collection',
          ) ?? state.attempts.at(-1)
        if (!current)
          return attempt === INITIAL_COLLECTION_ATTEMPT &&
            config.requireInitialClearance?.(binding)
            ? null
            : 'plate-state-uncertain'
        return current.id === attempt ? null : 'plate-attempt-mismatch'
      } catch {
        return 'plate-state-uncertain'
      }
    },
    confirmApiCollection(binding: PrinterBinding, attempt: string) {
      const key = config.printerKey(binding)
      if (key === undefined) throw new Error('Printer mapping unavailable')
      // The exact attempt was verified on the same stack as this durable write.
      if (
        attempt === INITIAL_COLLECTION_ATTEMPT &&
        config.journal.read(key).attempts.length === 0
      )
        config.journal.confirmInitial(key)
      else config.journal.confirmThrough(key, Number(attempt))
    },
    controls(binding: PrinterBinding): readonly ExtendedControlAction[] {
      const base = controls(binding)
      const key = config.printerKey(binding)
      let awaiting = false
      try {
        awaiting = key !== undefined && config.journal.awaiting(key).length > 0
      } catch {
        // Starts are refused anyway; a confirmation cannot be recorded.
      }
      // While a run awaits collection the printer stops advertising starts
      // and offers confirm_collection, so a client can see the hold first.
      if (!awaiting) return base
      const advertised = base.filter(
        (action) => !COLLECTION_HELD_ACTIONS.has(action),
      )
      return Object.freeze(
        advertised.includes('confirm_collection')
          ? advertised
          : [...advertised, 'confirm_collection' as const],
      )
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
      const refusal = plateStartRefusal(request.binding)
      if (key === undefined || refusal) {
        throw refused(
          refusal === 'awaiting-collection'
            ? 'Printer awaiting collection'
            : 'Printer start outcome uncertain',
          refusal === 'awaiting-collection',
        )
      }
      return execute(action, args, {
        ...request,
        beforeSend() {
          if (!request.beforeSend() || plateStartRefusal(request.binding))
            return false
          try {
            config.journal.dispatched(key, wall())
          } catch {
            throw refused('Collection journal unavailable', false)
          }
          return true
        },
      })
    },
  }) as D & PlateStartGuard
}
