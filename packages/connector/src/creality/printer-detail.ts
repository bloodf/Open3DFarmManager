import type { z } from 'zod'
import { PrinterDetailStreamUpdate } from '../../../farm-protocol/src/printer-detail.ts'
import {
  createCrealityTelemetryClient,
  type CrealityTelemetry,
} from './index.ts'

/**
 * Printer detail page for Creality stock firmware (E22.2). Every panel is built
 * from what the LAN WebSocket (port 9999) reports. Nothing the protocol does
 * not report is invented: toolhead position, bed mesh, services, power, queue,
 * history, timelapse and update status are absent, and the catalog marks them
 * `unsupported` (docs/protocols/creality-detail.md). Commands never travel
 * through this module: the signed control path sends them. Klipper-rooted
 * K-series printers keep the Moonraker detail stream.
 */

type Update = z.infer<typeof PrinterDetailStreamUpdate>

export const CREALITY_MAX_CONSOLE_LINE_BYTES = 256

export interface CrealityDetailOptions {
  cameraId?: string | undefined
  /** The console is the highest-risk write and stays off unless enabled. */
  consoleEnabled?: boolean | undefined
}

/** Pure mapping: one decoded status report in, one validated frame out. */
export function crealityDetailUpdate(
  printerKey: string,
  seq: number,
  report: CrealityTelemetry,
  options: CrealityDetailOptions = {},
): Update | undefined {
  const detail: Update['detail'] = {}
  const capabilities: Update['capabilities'] = []
  const heaters = [
    {
      name: 'extruder',
      temperature: report.nozzleTemp,
      target: report.nozzleTarget,
    },
    { name: 'bed', temperature: report.bedTemp, target: report.bedTarget },
  ].flatMap(({ name, temperature, target }) =>
    temperature === undefined
      ? []
      : [{ name, temperature, ...(target === undefined ? {} : { target }) }],
  )
  if (heaters.length) {
    capabilities.push('heaters')
    detail.heaters = heaters
  }
  if (report.fans) {
    capabilities.push('fans')
    detail.fans = Object.entries(report.fans).map(([name, percent]) => ({
      name,
      speed: percent / 100,
    }))
  }
  if (report.light?.chamber !== undefined) {
    capabilities.push('lights')
    detail.lights = [
      {
        name: 'chamber',
        red: 0,
        green: 0,
        blue: 0,
        white: Number(report.light.chamber),
      },
    ]
  }
  if (report.state) {
    capabilities.push('job')
    const file = report.filename
    detail.print = {
      state: report.state,
      message: '',
      ...(file && !/[\uD800-\uDFFF]/u.test(file) ? { file } : {}),
      ...(report.printDuration === undefined
        ? {}
        : { elapsedSeconds: report.printDuration }),
      ...(report.progress === undefined
        ? {}
        : { progress: report.progress / 100 }),
      ...(report.layer === undefined ? {} : { currentLayer: report.layer }),
      ...(report.totalLayer === undefined
        ? {}
        : { totalLayers: report.totalLayer }),
    }
  }
  if (options.cameraId) {
    capabilities.push('webcams')
    detail.webcams = [
      {
        uid: options.cameraId,
        name: 'Câmera da impressora',
        enabled: true,
        rotation: 0,
        flipHorizontal: false,
        flipVertical: false,
      },
    ]
  }
  if (options.consoleEnabled) capabilities.push('console')
  if (!capabilities.length) return undefined
  const parsed = PrinterDetailStreamUpdate.safeParse({
    v: 1,
    t: 'detail.update',
    printerKey,
    seq,
    vendor: 'creality',
    capabilities,
    detail,
  })
  return parsed.success ? parsed.data : undefined
}

/** Why the Connector refused to build a command. Nothing was sent. */
export type CrealityDetailRefusalReason =
  'disabled' | 'invalid-command' | 'state'
export class CrealityDetailRefused extends Error {
  readonly refusal: CrealityDetailRefusalReason
  constructor(refusal: CrealityDetailRefusalReason) {
    super(`Creality detail command refused: ${refusal}`)
    this.name = 'CrealityDetailRefused'
    this.refusal = refusal
  }
}

/** Tuning lines allowed while a job runs: M220 speed 10-500, M221 flow 5-150. */
const TUNING_ONLY =
  /^(?:M105|M114|M115)$|^M220 S(?:1\d|[2-9]\d|[1-4]\d\d|500)$|^M221 S(?:[5-9]\d|1[0-4]\d|150)$/i

/**
 * Console line under the E18.1 rules: one printable ASCII line of at most 256
 * bytes, sent as `gcodeCmd`. Off unless the console is enabled. An idle
 * printer accepts any such line; while printing or paused only the tuning
 * allow-list passes; an errored or unknown state refuses.
 */
export function buildCrealityConsoleLine(
  line: unknown,
  printState: unknown,
  enabled = false,
) {
  if (!enabled) throw new CrealityDetailRefused('disabled')
  if (
    typeof line !== 'string' ||
    line.trim() === '' ||
    line.length > CREALITY_MAX_CONSOLE_LINE_BYTES ||
    !/^[\x20-\x7e]+$/.test(line)
  )
    throw new CrealityDetailRefused('invalid-command')
  const clean = line.trim()
  if (printState === 'printing' || printState === 'paused') {
    if (!TUNING_ONLY.test(clean)) throw new CrealityDetailRefused('state')
  } else if (printState !== 'idle') throw new CrealityDetailRefused('state')
  return { method: 'set' as const, params: { gcodeCmd: clean } }
}

/** A lazy, reference-counted, read-only stream for a stock firmware endpoint. */
export function createCrealityDetailStream(
  binding: {
    printerKey: string
    host: string
    port?: number | undefined
    httpsPort?: number | undefined
    caFile?: string | undefined
  },
  options: CrealityDetailOptions = {},
) {
  const listeners = new Set<(frame: unknown) => void>()
  let client: ReturnType<typeof createCrealityTelemetryClient> | undefined
  let sequence = 0
  let latest: Update | undefined
  /** Stock firmware may push partial frames; keep the last known fields. */
  let known: CrealityTelemetry = {}
  const publish = (report: CrealityTelemetry) => {
    known = { ...known, ...report }
    const frame = crealityDetailUpdate(
      binding.printerKey,
      sequence++,
      known,
      options,
    )
    if (!frame) return
    latest = frame
    for (const listener of [...listeners]) listener(frame)
  }
  return {
    subscribe(listener: (frame: unknown) => void) {
      listeners.add(listener)
      client ??= createCrealityTelemetryClient({
        host: binding.host,
        ...(binding.httpsPort === undefined
          ? {}
          : { httpsPort: binding.httpsPort }),
        ...(binding.caFile === undefined ? {} : { caFile: binding.caFile }),
        ...(binding.port === undefined ? {} : { port: binding.port }),
        onTelemetry: publish,
        onDisconnect: () => {
          latest = undefined
          known = {}
        },
      })
      if (latest) listener(latest)
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        listeners.delete(listener)
        if (listeners.size) return
        void client?.close()
        client = undefined
        latest = undefined
        known = {}
      }
    },
  }
}
export type CrealityDetailStream = ReturnType<typeof createCrealityDetailStream>
