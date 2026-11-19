import { z } from 'zod'
import {
  ExtendedControlAction,
  MOONRAKER_CONTROLS,
} from '../../../farm-protocol/src/control-actions.ts'
import {
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import {
  validateMoonrakerInput,
  type MoonrakerLimits,
} from '../config/moonraker.ts'
import { supportedMoonrakerActions } from './commands.ts'
import { POWER_MARKER, readPowerDevices } from './control-power.ts'
import { queueMarkers } from './control-job-queue.ts'
import { readMacroParams, type MacroParamMap } from './control-macros.ts'
import { timelapseMarkers } from './control-timelapse.ts'
import { decodeMoonrakerFrame, Reply } from './frame.ts'
import { createMoonrakerSocket } from './socket.ts'

const MAX_OBJECTS = 512
export const MoonrakerObjectList = z.strictObject({
  objects: z.array(z.string().min(1).max(128)).max(MAX_OBJECTS),
})

/**
 * Actions to advertise for one Moonraker printer. Without a detected object
 * list only the three lifecycle actions are proven; an empty list is a real
 * detection result and never widens support.
 */
export function moonrakerControls(
  objects: readonly string[] | undefined,
): readonly ExtendedControlAction[] {
  if (!objects) return MOONRAKER_CONTROLS
  // The command builder treats "no objects" as "unknown, assume present".
  // A detected printer must not inherit that guess, so name a neutral object.
  const detected = objects.length ? objects : ['gcode']
  return Object.freeze(
    ExtendedControlAction.options.filter((action) =>
      supportedMoonrakerActions(detected).includes(action),
    ),
  )
}

type DetectInput = {
  binding: PrinterBinding
  allowedOrigins: readonly string[]
  limits: MoonrakerLimits
  signal: AbortSignal
}

/**
 * One read-only request on its own short connection to the locally bound,
 * allowlisted origin. Sends nothing else and never retries.
 */
function readOnlyOnce<T>(
  input: DetectInput,
  request: { method: string; params?: unknown },
  parse: (result: unknown) => T,
): Promise<T> {
  const mapping = readPrinterBinding(input.binding)
  if (!mapping || !mapping.moonraker_origin || input.signal.aborted)
    return Promise.reject(new Error('Moonraker support detection unavailable'))
  const selected = validateMoonrakerInput({
    assignment: {
      printerKey: mapping.printer_key,
      origin: mapping.moonraker_origin,
    },
    allowedOrigins: input.allowedOrigins,
    limits: input.limits,
  })
  return new Promise<T>((resolve, reject) => {
    const socket = createMoonrakerSocket(selected.origin, selected.limits)
    let settled = false
    const finish = (parsed?: { value: T }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal.removeEventListener('abort', abort)
      socket.terminate()
      if (parsed && readPrinterBinding(input.binding) === mapping)
        resolve(parsed.value)
      else reject(new Error('Moonraker support detection unavailable'))
    }
    const abort = () => finish()
    const timer = setTimeout(
      abort,
      Math.min(
        8000,
        selected.limits.connectTimeoutMs + selected.limits.requestTimeoutMs,
      ),
    )
    input.signal.addEventListener('abort', abort, { once: true })
    socket.on('error', abort)
    socket.on('close', abort)
    socket.on('open', () => {
      if (settled) return
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: 1, ...request }),
        { binary: false, compress: false },
        (error) => {
          if (error) abort()
        },
      )
    })
    socket.on('message', (data, binary) => {
      try {
        const reply = Reply.parse(
          decodeMoonrakerFrame(data, binary, selected.limits.maxMessageBytes),
        )
        if (reply.id !== 1) throw new Error('Unexpected reply')
        finish({ value: parse(reply.result) })
      } catch {
        abort()
      }
    })
  })
}

/** One read-only printer.objects.list. */
export function detectMoonrakerObjects(
  input: DetectInput,
): Promise<readonly string[]> {
  return readOnlyOnce(input, { method: 'printer.objects.list' }, (result) =>
    Object.freeze([...MoonrakerObjectList.parse(result).objects]),
  )
}

/**
 * One read-only configfile query: the parameters each advertised macro reads.
 * A failure rejects; the caller keeps "no parameters" rather than guessing.
 */
export function detectMoonrakerMacroParams(
  input: DetectInput,
  macros: readonly string[],
): Promise<MacroParamMap> {
  return readOnlyOnce(
    input,
    {
      method: 'printer.objects.query',
      params: { objects: { configfile: ['config'] } },
    },
    (result) => readMacroParams(result, macros),
  )
}

const PowerComponent = z.object({
  components: z.array(z.string()).max(512),
})

/** True only when a `server.info` reply lists the power component. */
const powerListed = (result: unknown) => {
  const info = PowerComponent.safeParse(result)
  return info.success && info.data.components.includes('power')
}

/**
 * Read the Moonraker components, then the power device catalogue only when
 * `server.info` lists the power component. Advertise each capability only
 * when its probe succeeds.
 */
export async function detectMoonrakerComponents(
  input: DetectInput,
): Promise<readonly string[]> {
  const info = await readOnlyOnce(
    input,
    { method: 'server.info' },
    (result) => ({
      markers: [...queueMarkers(result), ...timelapseMarkers(result)],
      power: powerListed(result),
    }),
  ).catch(() => ({ markers: [], power: false }))
  if (!info.power) return info.markers
  const devices = await readPowerDevices((method) =>
    readOnlyOnce(input, { method }, (result) => result),
  ).catch(() => [])
  return [...info.markers, ...(devices.length ? [POWER_MARKER] : [])]
}
