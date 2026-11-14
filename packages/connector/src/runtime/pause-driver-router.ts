import { openFixedCrealityControl } from '../creality/control-driver.ts'
import { CREALITY_ACTIONS } from '../creality/commands.ts'
import { readCrealityPrinterBinding } from '../control/printer-binding.ts'
import { openFixedBambuControl } from '../bambu/control-driver.ts'
import { bambuControls } from '../bambu/control-support.ts'
import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'
import {
  detectMoonrakerObjects,
  moonrakerControls,
} from '../moonraker/control-support.ts'
import { openFixedMoonrakerPause } from '../moonraker/pause-driver.ts'
import {
  readPrinterBinding,
  readBambuPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import type {
  ControlObservation,
  PauseDriver,
  PreparedPauseDriver,
} from '../control/pause-dispatcher.ts'
import type { MoonrakerLimits } from '../config/moonraker.ts'
import { controlWithinLimits, type ControlLimits } from './control-limits.ts'

/**
 * Router surface. `controls` is the one source for what a printer advertises:
 * it lists exactly the actions `execute` will route for that binding.
 */
export interface ExtendedControlDriver extends PreparedPauseDriver {
  controls(binding: PrinterBinding): readonly ExtendedControlAction[]
  execute: NonNullable<PauseDriver['execute']>
  /**
   * Read-only Moonraker support detection (printer.objects.list). Until it
   * succeeds a Moonraker printer advertises its lifecycle actions only.
   */
  detect(
    binding: PrinterBinding,
    signal?: AbortSignal,
  ): Promise<readonly ExtendedControlAction[]>
}

/** Trusted local composition. No command, endpoint or capability comes from the wire. */
export function createPauseDriverRouter(config: {
  allowedOrigins: readonly string[]
  limits: MoonrakerLimits
  clock: { monotonicNow(): number }
  /** Connector-side ceilings, enforced again here before any driver call. */
  controlLimits?: ControlLimits
  /**
   * Locally provisioned Bambu model. Naming it opts that printer into the
   * extended actions its model supports; nothing from the wire can.
   */
  bambuModel?(binding: PrinterBinding): string | undefined
  observe(
    binding: PrinterBinding,
    observation: ControlObservation | null,
  ): boolean
}): ExtendedControlDriver {
  type Attempt = {
    driver: Pick<
      ReturnType<typeof openFixedMoonrakerPause>,
      'prepare' | 'driver' | 'close'
    >
    detach(): void
  }
  const generations = new Map<PrinterBinding, number>()
  const attempts = new Map<PrinterBinding, Attempt>()
  const moonrakerObjects = new WeakMap<PrinterBinding, readonly string[]>()
  // KobraLink bindings are read-only handles with no command mapping, so they
  // resolve to no binding here and advertise nothing.
  function controls(binding: PrinterBinding): readonly ExtendedControlAction[] {
    if (!readPrinterBinding(binding)) return []
    if (readCrealityPrinterBinding(binding)) return CREALITY_ACTIONS
    const bambu = readBambuPrinterBinding(binding)
    if (bambu)
      return bambu.control ? bambuControls(config.bambuModel?.(binding)) : []
    return moonrakerControls(moonrakerObjects.get(binding))
  }
  return Object.freeze({
    controls,
    async detect(binding: PrinterBinding, signal?: AbortSignal) {
      if (
        readPrinterBinding(binding) &&
        !readBambuPrinterBinding(binding) &&
        !readCrealityPrinterBinding(binding)
      )
        moonrakerObjects.set(
          binding,
          await detectMoonrakerObjects({
            binding,
            allowedOrigins: config.allowedOrigins,
            limits: config.limits,
            signal: signal ?? new AbortController().signal,
          }),
        )
      return controls(binding)
    },
    async prepare({
      binding,
      signal,
    }: Parameters<PreparedPauseDriver['prepare']>[0]) {
      if (
        !readPrinterBinding(binding) ||
        (readBambuPrinterBinding(binding) !== null &&
          !readBambuPrinterBinding(binding)?.control) ||
        signal.aborted ||
        attempts.has(binding)
      )
        throw new Error('Pause attempt unavailable')
      const previous = generations.get(binding) ?? 0
      if (
        previous >= Number.MAX_SAFE_INTEGER ||
        (!generations.has(binding) && generations.size >= 1000)
      )
        throw new Error('Pause generation exhausted')
      const generation = previous + 1
      generations.set(binding, generation)
      let attempt: Attempt | undefined
      const owner = new AbortController()
      const abort = () => owner.abort()
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) owner.abort()
      let fixed: Pick<
        ReturnType<typeof openFixedMoonrakerPause>,
        'prepare' | 'driver' | 'close'
      >
      try {
        fixed = (
          readCrealityPrinterBinding(binding)
            ? openFixedCrealityControl
            : readBambuPrinterBinding(binding)
              ? openFixedBambuControl
              : openFixedMoonrakerPause
        )({
          binding,
          allowedOrigins: config.allowedOrigins,
          limits: config.limits,
          connectionGeneration: generation,
          objects: moonrakerObjects.get(binding),
          clock: config.clock,
          signal: owner.signal,
          publish(observation) {
            if (
              attempt &&
              attempts.get(binding) === attempt &&
              generations.get(binding) === generation
            )
              config.observe(binding, observation)
          },
        })
      } catch (error) {
        signal.removeEventListener('abort', abort)
        throw error
      }
      attempt = {
        driver: fixed,
        detach: () => signal.removeEventListener('abort', abort),
      }
      attempts.set(binding, attempt)
      await fixed.prepare()
      if (
        signal.aborted ||
        attempts.get(binding) !== attempt ||
        !readPrinterBinding(binding)
      )
        throw new Error('Pause attempt retired')
      return { connectionGeneration: generation }
    },
    execute(
      action: ExtendedControlAction,
      args: Record<string, unknown>,
      input: Parameters<NonNullable<PauseDriver['execute']>>[2],
    ) {
      const attempt = attempts.get(input.binding)
      if (!attempt)
        return Promise.reject(new Error('No prepared pause attempt'))
      // Both checks precede the driver, so a refusal can never reach a printer.
      if (
        !controls(input.binding).includes(action) ||
        !controlWithinLimits(action, args, config.controlLimits) ||
        !attempt.driver.driver.execute
      )
        return Promise.reject(new Error('Control action unavailable'))
      return attempt.driver.driver.execute(action, args, input)
    },
    pauseOnce(input: Parameters<PreparedPauseDriver['pauseOnce']>[0]) {
      const attempt = attempts.get(input.binding)
      if (!attempt)
        return Promise.reject(new Error('No prepared pause attempt'))
      return attempt.driver.driver.pauseOnce(input)
    },
    waitForPaused(input: Parameters<PreparedPauseDriver['waitForPaused']>[0]) {
      const attempt = attempts.get(input.binding)
      if (!attempt)
        return Promise.reject(new Error('No prepared pause attempt'))
      return attempt.driver.driver.waitForPaused(input).then((observation) => {
        attempt.detach()
        return observation
      })
    },
    async closeAttempt(binding: PrinterBinding) {
      const attempt = attempts.get(binding)
      if (!attempt) return
      await attempt.driver.close()
      attempt.detach()
      if (attempts.get(binding) === attempt) attempts.delete(binding)
    },
  })
}
