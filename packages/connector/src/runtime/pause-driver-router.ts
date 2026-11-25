import { advertisedMoonrakerMacros } from '../control/macro-support.ts'
import { openFixedKobraLinkControl } from '../kobralink/control-driver.ts'
import { KOBRALINK_CONTROLS } from '../kobralink/extended-control.ts'
import type { KobraLinkFetch } from '../kobralink/client.ts'
import { readKobraLinkPrinterBinding } from '../control/printer-binding.ts'
import { openFixedAnycubicControl } from '../anycubic/control-driver.ts'
import {
  KOBRA_X_SIGNED_ACTIONS,
  openFixedKobraXControl,
} from '../kobra-x/control-driver.ts'
import { anycubicControls } from '../anycubic/control-support.ts'
import { readAnycubicPrinterBinding } from '../control/printer-binding.ts'
import { openFixedCrealityControl } from '../creality/control-driver.ts'
import { CREALITY_ACTIONS } from '../creality/commands.ts'
import { readCrealityPrinterBinding } from '../control/printer-binding.ts'
import { openFixedBambuControl } from '../bambu/control-driver.ts'
import { openFixedSdcpControl } from '../sdcp/control-driver.ts'
import { SDCP_CONTROL_ACTIONS } from '../sdcp/models.ts'
import { readSdcpPrinterBinding } from '../control/printer-binding.ts'
import { bambuControls } from '../bambu/control-support.ts'
import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'
import {
  detectMoonrakerComponents,
  detectMoonrakerMacroParams,
  detectMoonrakerObjects,
  moonrakerControls,
} from '../moonraker/control-support.ts'
import type { MacroParamMap } from '../moonraker/control-macros.ts'
import { consoleSupported } from '../moonraker/control-console.ts'
import { openFixedMoonrakerPause } from '../moonraker/pause-driver.ts'
import { isDeclaredSnapmakerU1 } from '../moonraker/u1-tools.ts'
import {
  SNAPMAKER_U1_MARKER,
  snapmakerU1Controls,
} from '../moonraker/u1-marker.ts'
import {
  readPrinterBinding,
  readBambuPrinterBinding,
  readKobraXPrinterBinding,
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
  /** Parameters each macro reads, from the printer's own config. */
  macroParams?(binding: PrinterBinding): MacroParamMap | undefined
  detect(
    binding: PrinterBinding,
    signal?: AbortSignal,
  ): Promise<readonly ExtendedControlAction[]>
}

/** Trusted local composition. No command, endpoint or capability comes from the wire. */
type PrepareInput = Parameters<PreparedPauseDriver['prepare']>[0] & {
  observeRun?: (
    evidence: import('./api-job-lifecycle.ts').ApiRunEvidence,
  ) => void
}

export function createPauseDriverRouter(config: {
  kobraLinkFetch?: KobraLinkFetch
  connectKobraX?: NonNullable<
    Parameters<typeof openFixedKobraXControl>[0]['connect']
  >
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
  /** Local per-printer admin switch of the G-code console; absent means off. */
  gcodeConsole?(binding: PrinterBinding): boolean
  observe(
    binding: PrinterBinding,
    observation: ControlObservation | null,
  ): boolean
}): Omit<ExtendedControlDriver, 'prepare'> & {
  prepare(input: PrepareInput): ReturnType<PreparedPauseDriver['prepare']>
} {
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
  const moonrakerMacroParams = new WeakMap<PrinterBinding, MacroParamMap>()
  // KobraLink bindings are read-only handles with no command mapping, so they
  // resolve to no binding here and advertise nothing.
  function controls(binding: PrinterBinding): readonly ExtendedControlAction[] {
    const mapping = readPrinterBinding(binding)
    if (!mapping) return []
    if (readKobraLinkPrinterBinding(binding)) return KOBRALINK_CONTROLS
    if (readCrealityPrinterBinding(binding)) return CREALITY_ACTIONS
    if (readKobraXPrinterBinding(binding)) return KOBRA_X_SIGNED_ACTIONS
    if (readSdcpPrinterBinding(binding)) return SDCP_CONTROL_ACTIONS
    const anycubic = readAnycubicPrinterBinding(binding)
    if (anycubic) return anycubicControls(anycubic.modelId)
    const bambu = readBambuPrinterBinding(binding)
    if (bambu)
      return bambu.control
        ? bambuControls(
            config.bambuModel?.(binding) ?? bambu.model,
            config.gcodeConsole?.(binding) === true,
          )
        : []
    const objects = moonrakerObjects.get(binding)
    if (isDeclaredSnapmakerU1(mapping.printer_key))
      return Object.freeze(
        snapmakerU1Controls(objects).filter(
          (action) => action !== 'gcode' || config.gcodeConsole?.(binding),
        ),
      )
    const found = moonrakerControls(objects)
    return config.gcodeConsole?.(binding) && consoleSupported(objects)
      ? Object.freeze([...found, 'gcode' as const])
      : found
  }
  return Object.freeze({
    controls,
    allowsExtendedResult(binding: PrinterBinding) {
      const mapping = readPrinterBinding(binding)
      return (
        !!mapping?.moonraker_origin &&
        isDeclaredSnapmakerU1(mapping.printer_key) &&
        moonrakerObjects.get(binding)?.includes(SNAPMAKER_U1_MARKER) === true
      )
    },
    macros: (binding: PrinterBinding) =>
      advertisedMoonrakerMacros(moonrakerObjects.get(binding)),
    macroParams: (binding: PrinterBinding) => moonrakerMacroParams.get(binding),
    async detect(binding: PrinterBinding, signal?: AbortSignal) {
      if (
        readPrinterBinding(binding) &&
        !readKobraLinkPrinterBinding(binding) &&
        !readBambuPrinterBinding(binding) &&
        !readCrealityPrinterBinding(binding) &&
        !readKobraXPrinterBinding(binding) &&
        !readSdcpPrinterBinding(binding) &&
        !readAnycubicPrinterBinding(binding)
      ) {
        const detect = {
          binding,
          allowedOrigins: config.allowedOrigins,
          limits: config.limits,
          signal: signal ?? new AbortController().signal,
        }
        const objects = await detectMoonrakerObjects(detect)
        moonrakerObjects.set(binding, objects)
        try {
          // Components such as the job queue are not Klipper objects.
          const markers = await detectMoonrakerComponents(detect)
          if (markers.length)
            moonrakerObjects.set(
              binding,
              Object.freeze([...objects, ...markers]),
            )
        } catch {
          // Unknown components stay unadvertised.
        }
        const macros = advertisedMoonrakerMacros(objects) ?? []
        if (macros.length)
          try {
            moonrakerMacroParams.set(
              binding,
              await detectMoonrakerMacroParams(detect, macros),
            )
          } catch {
            // Unknown parameters stay unknown: macros run without any.
          }
      }
      return controls(binding)
    },
    async prepare({ binding, signal, observeRun }: PrepareInput) {
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
          readKobraLinkPrinterBinding(binding)
            ? openFixedKobraLinkControl
            : readKobraXPrinterBinding(binding)
              ? openFixedKobraXControl
              : readAnycubicPrinterBinding(binding)
                ? openFixedAnycubicControl
                : readSdcpPrinterBinding(binding)
                  ? openFixedSdcpControl
                  : readCrealityPrinterBinding(binding)
                    ? openFixedCrealityControl
                    : readBambuPrinterBinding(binding)
                      ? openFixedBambuControl
                      : openFixedMoonrakerPause
        )({
          binding,
          fetch: config.kobraLinkFetch,
          ...(config.connectKobraX ? { connect: config.connectKobraX } : {}),
          allowedOrigins: config.allowedOrigins,
          limits: config.limits,
          connectionGeneration: generation,
          objects: moonrakerObjects.get(binding),
          gcodeConsole: config.gcodeConsole?.(binding) === true,
          clock: config.clock,
          observeRun,
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
