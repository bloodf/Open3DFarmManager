import { setTimeout as delay } from 'node:timers/promises'
import type { RawPrinterObservation } from '../runtime/farm-snapshot-provider.ts'
import {
  FlashforgeBindingSchema,
  readFlashforgeCredentials,
  type FlashforgeBinding,
} from './config.ts'
import { createFlashforgeAdapter } from './index.ts'
import {
  READ_ONLY_POLL_BUDGET_MS,
  READ_ONLY_POLL_MS,
} from '../runtime/snapshot-window.ts'

type Printer = Omit<RawPrinterObservation['printer'], 'statusReason'> & {
  statusReason: 'flashforge-simulated' | 'flashforge-unqualified'
}
export type FlashforgeObservation = Omit<
  RawPrinterObservation,
  'printer' | 'fieldObservedAtMonoMs'
> & {
  printer: Printer
  fieldObservedAtMonoMs: { flashforge: Partial<Record<keyof Printer, number>> }
}

type Status = Awaited<
  ReturnType<ReturnType<typeof createFlashforgeAdapter>['readStatus']>
>

/**
 * AD5X trays for the farm page, named `ifs:0` to `ifs:3`. Published only with
 * the station's 1-4 numbering, so a tray never names the wrong slot.
 */
function stationMaterials(
  slots: Status['slots'],
  station: Status['station'],
): Printer['materials'] {
  if (
    !slots?.length ||
    slots.some((slot) => slot.id < 1) ||
    new Set(slots.map((slot) => slot.id)).size !== slots.length
  )
    return undefined
  return slots.map((slot) => {
    const color = /^#?([0-9a-fA-F]{6})$/.exec(slot.color ?? '')?.[1]
    return {
      slot: `ifs:${slot.id - 1}`,
      ...(slot.material && slot.material.length <= 64
        ? { materialType: slot.material }
        : {}),
      ...(color ? { colorHex: `${color.toUpperCase()}FF` } : {}),
      ...(station?.currentSlot === undefined
        ? {}
        : { active: station.currentSlot === slot.id }),
    }
  })
}

export function createFlashforgeCollection(input: {
  binding: FlashforgeBinding
  allowedOrigins: readonly string[]
  signal: AbortSignal
  timeoutMs: number
  onObservation: (observation: FlashforgeObservation) => void
  onUnavailable: (epoch: number) => void
}) {
  const binding = FlashforgeBindingSchema.parse(input.binding)
  if (!input.allowedOrigins.includes(binding.origin)) {
    throw new Error('Flashforge collector origin not allowlisted')
  }
  const url = new URL(binding.origin)
  const { readStatus } = createFlashforgeAdapter({
    host: url.hostname,
    port: Number(url.port),
    timeoutMs: Math.min(input.timeoutMs, READ_ONLY_POLL_BUDGET_MS),
    ...readFlashforgeCredentials(binding),
  })
  const { signal } = input
  let epoch = 1
  let unavailable = false

  async function poll() {
    const result = await readStatus(signal)
    if (result.model !== binding.expect.model)
      throw new Error('Flashforge model mismatch')
    const state =
      result.status === 'printing'
        ? 'printing'
        : result.status === 'pause'
          ? 'paused'
          : result.status === 'ready' ||
              result.status === 'completed' ||
              result.status === 'cancel'
            ? 'idle'
            : result.status === 'error'
              ? 'error'
              : 'unknown'
    const mono = performance.now()
    const materials = stationMaterials(result.slots, result.station)
    const progress = result.progress
    if (
      progress === undefined &&
      (state === 'printing' || state === 'paused')
    ) {
      throw new Error('Flashforge job progress unavailable')
    }
    return {
      printerKey: binding.printerKey,
      epoch,
      printer: {
        printerKey: binding.printerKey,
        state,
        ...(progress === undefined ? {} : { progress }),
        ...(materials ? { materials } : {}),
        identity: {
          vendor: 'Flashforge',
          model: result.model,
          firmware: result.firmware,
        },
        statusReason: binding.simulated
          ? 'flashforge-simulated'
          : 'flashforge-unqualified',
        observedAt: Date.now(),
      },
      receivedAtMonoMs: mono,
      fieldObservedAtMonoMs: {
        flashforge: {
          state: mono,
          identity: mono,
          statusReason: mono,
          ...(materials ? { materials: mono } : {}),
          ...(progress === undefined ? {} : { progress: mono }),
        },
      },
    } satisfies FlashforgeObservation
  }

  async function run() {
    while (!signal.aborted) {
      try {
        const observation = await poll()
        if (signal.aborted) return
        input.onObservation(observation)
        unavailable = false
      } catch {
        if (!signal.aborted && !unavailable) {
          unavailable = true
          input.onUnavailable(epoch++)
        }
      }
      try {
        await delay(READ_ONLY_POLL_MS, undefined, { signal })
      } catch (error) {
        if (!signal.aborted) throw error
      }
    }
  }

  return { done: run() }
}
