import { openFixedMoonrakerPause } from '../moonraker/pause-driver.ts'
import {
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import type {
  ControlObservation,
  PreparedPauseDriver,
} from '../control/pause-dispatcher.ts'
import type { MoonrakerLimits } from '../config/moonraker.ts'

/** Trusted local composition. No command, endpoint or capability comes from the wire. */
export function createPauseDriverRouter(config: {
  allowedOrigins: readonly string[]
  limits: MoonrakerLimits
  clock: { monotonicNow(): number }
  observe(
    binding: PrinterBinding,
    observation: ControlObservation | null,
  ): boolean
}): PreparedPauseDriver {
  type Attempt = {
    driver: ReturnType<typeof openFixedMoonrakerPause>
    detach(): void
  }
  const generations = new Map<PrinterBinding, number>()
  const attempts = new Map<PrinterBinding, Attempt>()
  return Object.freeze({
    async prepare({
      binding,
      signal,
    }: Parameters<PreparedPauseDriver['prepare']>[0]) {
      if (
        !readPrinterBinding(binding) ||
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
      let fixed: ReturnType<typeof openFixedMoonrakerPause>
      try {
        fixed = openFixedMoonrakerPause({
          binding,
          allowedOrigins: config.allowedOrigins,
          limits: config.limits,
          connectionGeneration: generation,
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
