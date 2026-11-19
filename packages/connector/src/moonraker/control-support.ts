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
import { queueMarkers, serverInfoWire } from './control-job-queue.ts'
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

/**
 * One read-only printer.objects.list, then one read-only server.info, on its
 * own short connection to the locally bound, allowlisted origin. Sends nothing
 * else and never retries. The component list adds a marker entry when the job
 * queue is loaded; a missing or unreadable server.info only leaves it out.
 */
export function detectMoonrakerObjects(input: {
  binding: PrinterBinding
  allowedOrigins: readonly string[]
  limits: MoonrakerLimits
  signal: AbortSignal
}): Promise<readonly string[]> {
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
  return new Promise<readonly string[]>((resolve, reject) => {
    const socket = createMoonrakerSocket(selected.origin, selected.limits)
    let settled = false
    // Set once the object list is read; server.info then only adds markers.
    let detected: readonly string[] | undefined
    let infoTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (objects?: readonly string[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(infoTimer)
      input.signal.removeEventListener('abort', abort)
      socket.terminate()
      if (objects && readPrinterBinding(input.binding) === mapping)
        resolve(objects)
      else reject(new Error('Moonraker support detection unavailable'))
    }
    const abort = () => finish(input.signal.aborted ? undefined : detected)
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
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'printer.objects.list',
        }),
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
        if (detected) {
          if (reply.id !== 2) throw new Error('Unexpected reply')
          finish(Object.freeze([...detected, ...queueMarkers(reply.result)]))
          return
        }
        if (reply.id !== 1) throw new Error('Unexpected reply')
        detected = Object.freeze([
          ...MoonrakerObjectList.parse(reply.result).objects,
        ])
        // A server that never answers server.info keeps its object list.
        infoTimer = setTimeout(
          abort,
          Math.min(1000, selected.limits.requestTimeoutMs),
        )
        socket.send(
          serverInfoWire(2),
          { binary: false, compress: false },
          (error) => {
            if (error) abort()
          },
        )
      } catch {
        abort()
      }
    })
  })
}
