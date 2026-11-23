import { readFileSync } from 'node:fs'
import type { z } from 'zod'
import {
  PrinterDetailStreamUpdate,
  type PrinterDetailStreamQueryKind as QueryKindSchema,
} from '../../../farm-protocol/src/printer-detail.ts'
import { ControlArguments } from '../../../farm-protocol/src/control-actions.ts'
import { parseBambuBinding, type BambuBinding } from './configuration.ts'
import { readBambuCredentials } from './credentials.ts'
import { decodeBambuReport } from './report.ts'
import { createBambuTransport } from './transport.ts'
import { bambuFtps, type BambuSdFolder } from './ftps-ops.ts'
import type { BambuListOptions } from './files.ts'

/**
 * Printer detail page for Bambu printers (E22.1). Everything here is built from
 * what the LAN protocol reports (MQTT report topic) or from the SD card over
 * FTPS. Nothing the protocol does not report is invented: the toolhead
 * position, bed mesh, services, power, job queue and update status are simply
 * absent, and the catalog marks those areas `unsupported`
 * (docs/protocols/bambu-detail.md). Commands never travel through this module:
 * it only builds the `gcode_line` payloads that the signed control path sends.
 */

export const BAMBU_DETAIL_CAPABILITIES = [
  'heaters',
  'fans',
  'lights',
  'motion',
  'speed',
  'console',
  'timelapse',
] as const

/** Bambu speed levels as the vendor documents them (print_speed 1-4). */
const SPEED_LEVEL_FACTOR: Record<number, number> = {
  1: 0.5,
  2: 1,
  3: 1.24,
  4: 1.66,
}
export const DETAIL_MIN_INTERVAL_MS = 250
/** Lowest nozzle temperature at which the Connector lets filament move. */
export const BAMBU_MIN_EXTRUDE_C = 170
export const BAMBU_MAX_EXTRUDE_C = 300
export const BAMBU_MAX_CONSOLE_LINE_BYTES = 256

type QueryKind = z.infer<typeof QueryKindSchema>
type Raw = Record<string, unknown>
const object = (value: unknown): Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Raw)
    : {}
const finite = (value: unknown): number | undefined => {
  const parsed =
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed)
    ? parsed
    : undefined
}

/** Merge AMS deltas by unit and tray so a partial report keeps known slots. */
function mergeAms(previous: unknown, next: unknown): Raw {
  const before = object(previous)
  const after = object(next)
  const merged: Raw = { ...before, ...after }
  if (Array.isArray(after.ams)) {
    const units = new Map<unknown, Raw>(
      (Array.isArray(before.ams) ? before.ams : []).map((unit: unknown) => [
        object(unit).id,
        object(unit),
      ]),
    )
    for (const raw of after.ams) {
      const unit = object(raw)
      const known = units.get(unit.id)
      const trays = new Map<unknown, Raw>(
        (Array.isArray(known?.tray) ? known.tray : []).map((tray: unknown) => [
          object(tray).id,
          object(tray),
        ]),
      )
      for (const tray of Array.isArray(unit.tray) ? unit.tray : [])
        trays.set(object(tray).id, {
          ...trays.get(object(tray).id),
          ...object(tray),
        })
      units.set(unit.id, { ...known, ...unit, tray: [...trays.values()] })
    }
    merged.ams = [...units.values()]
  }
  return merged
}

function alarmWord(value: unknown): string | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffffffff
    ? value.toString(16).toUpperCase().padStart(8, '0')
    : undefined
}

function hmsCodes(value: unknown): string[] | undefined {
  // Keep the whole list within the detail stream's message limit.
  if (!Array.isArray(value) || value.length > 64) return undefined
  const codes = new Set<string>()
  for (const entry of value) {
    const { attr, code } = object(entry)
    const prefix = alarmWord(attr)
    const suffix = alarmWord(code)
    if (prefix === undefined || suffix === undefined) return undefined
    const fullCode = prefix + suffix
    codes.add(fullCode.replace(/(.{4})(?=.)/g, '$1-'))
  }
  return [...codes]
}

/** Pure accumulator: raw MQTT reports in, validated `detail.update` frames out. */
export function createBambuDetailState(printerKey: string) {
  let print: Raw = {}
  let printError: string | undefined
  let hms: string[] | undefined
  let seq = 0
  return {
    /** Undefined for reports that carry no print telemetry (version, upgrade). */
    ingest(payload: string | Buffer): unknown | undefined {
      const text = typeof payload === 'string' ? payload : payload.toString()
      const decoded = decodeBambuReport(text)
      if (decoded.kind !== 'observation') return undefined
      const delta = object(object(JSON.parse(text)).print)
      const command =
        typeof delta.command === 'string'
          ? delta.command.toLowerCase()
          : undefined
      if (
        command === undefined ||
        command === 'push_status' ||
        command === 'pushall'
      ) {
        const error = alarmWord(delta.print_error)
        if (error !== undefined)
          printError =
            error === '00000000' ? '' : `${error.slice(0, 4)}-${error.slice(4)}`
        if ('hms' in delta) hms = hmsCodes(delta.hms)
      }
      print = {
        ...print,
        ...delta,
        ...(delta.ams === undefined
          ? {}
          : { ams: mergeAms(print.ams, delta.ams) }),
      }
      return this.frame()
    },
    reset() {
      print = {}
      printError = undefined
      hms = undefined
    },
    /** Latest raw `print` object, for Connector-side refusals. */
    get print(): Readonly<Raw> {
      return print
    },
    frame(): unknown | undefined {
      const observed = decodeBambuReport({ print })
      if (observed.kind !== 'observation') return undefined
      const heater = (name: string, current: unknown, target: unknown) => {
        const temperature = finite(current)
        return temperature === undefined
          ? []
          : [{ name, temperature, target: finite(target) ?? 0, power: 0 }]
      }
      const level = finite(print.spd_lvl)
      const magnitude = finite(print.spd_mag)
      const speedFactor =
        magnitude !== undefined && magnitude >= 0
          ? magnitude / 100
          : level === undefined
            ? undefined
            : SPEED_LEVEL_FACTOR[level]
      const light = observed.light?.chamber
      const parsed = PrinterDetailStreamUpdate.safeParse({
        v: 1,
        t: 'detail.update',
        printerKey,
        seq: seq++,
        vendor: 'bambu',
        capabilities: [...BAMBU_DETAIL_CAPABILITIES],
        detail: {
          heaters: [
            ...heater(
              'extruder',
              print.nozzle_temper,
              print.nozzle_target_temper,
            ),
            ...heater('bed', print.bed_temper, print.bed_target_temper),
            ...heater('chamber', print.chamber_temper, 0),
          ],
          fans: Object.entries(observed.fans ?? {}).map(([name, percent]) => ({
            name,
            speed: (percent ?? 0) / 100,
          })),
          ...(light === undefined
            ? {}
            : {
                lights: [
                  {
                    name: 'chamber_light',
                    red: light ? 1 : 0,
                    green: light ? 1 : 0,
                    blue: light ? 1 : 0,
                  },
                ],
              }),
          ...(speedFactor === undefined ? {} : { speedFactor }),
          print: {
            state: observed.state ?? 'unknown',
            message: [
              printError && `Erro de impressão: ${printError}.`,
              hms?.length && `Códigos HMS informados: ${hms.join(', ')}.`,
              (printError === undefined || hms === undefined) &&
                'Alertas ainda não informados pela impressora.',
            ]
              .filter(Boolean)
              .join(' '),
            // The report carries remaining time, not elapsed time.
            elapsedSeconds: 0,
            ...(observed.filename ? { file: observed.filename } : {}),
            ...(observed.currentLayer === undefined
              ? {}
              : { currentLayer: observed.currentLayer }),
            ...(observed.totalLayer === undefined
              ? {}
              : { totalLayers: observed.totalLayer }),
          },
        },
      })
      return parsed.success ? parsed.data : undefined
    },
  }
}

/** Why the Connector refused to build a command. Nothing was sent. */
export type BambuDetailRefusalReason =
  'invalid-command' | 'state' | 'unsupported-action'
export class BambuDetailRefused extends Error {
  readonly refusal: BambuDetailRefusalReason
  constructor(refusal: BambuDetailRefusalReason) {
    super(`Bambu detail command refused: ${refusal}`)
    this.name = 'BambuDetailRefused'
    this.refusal = refusal
  }
}

const trim = (value: number) => String(Number(value.toFixed(3)))
const gcodeLine = (script: string, sequence_id = '0') => ({
  print: { command: 'gcode_line', param: `${script}\n`, sequence_id },
})

/**
 * Jog: one relative move under the E18.1 bounds (0.01-100 mm in 0.01 steps,
 * 60-18000 mm/min), then back to absolute positioning.
 */
export function buildBambuJog(args: unknown, sequenceId?: string) {
  const parsed = ControlArguments.safeParse({ action: 'jog', args })
  if (!parsed.success || parsed.data.action !== 'jog')
    throw new BambuDetailRefused('invalid-command')
  const { axis, distance_mm, feed } = parsed.data.args
  return gcodeLine(
    `G91\nG1 ${axis.toUpperCase()}${trim(distance_mm)} F${feed}\nG90`,
    sequenceId,
  )
}

/**
 * Extrude under the E18.1 bounds (tool 0 only: one nozzle; -50..100 mm, feed
 * 1-6000). A cold or unknown nozzle refuses, never a guess.
 */
export function buildBambuExtrude(
  args: unknown,
  nozzleC: unknown,
  sequenceId?: string,
) {
  const parsed = ControlArguments.safeParse({ action: 'extrude', args })
  if (!parsed.success || parsed.data.action !== 'extrude')
    throw new BambuDetailRefused('invalid-command')
  const { tool, length_mm, feed } = parsed.data.args
  if (tool !== 0) throw new BambuDetailRefused('unsupported-action')
  const temperature = typeof nozzleC === 'number' ? nozzleC : undefined
  if (
    temperature === undefined ||
    !Number.isFinite(temperature) ||
    temperature < BAMBU_MIN_EXTRUDE_C ||
    temperature > BAMBU_MAX_EXTRUDE_C
  )
    throw new BambuDetailRefused('state')
  return gcodeLine(
    `M83\nG1 E${trim(length_mm)} F${Math.round(feed)}\nM82`,
    sequenceId,
  )
}

const TUNING_ONLY =
  /^(?:M105|M114|M115)$|^M220 S(?:1\d|[2-9]\d|[1-4]\d\d|500)$|^M221 S(?:[5-9]\d|1[0-4]\d|150)$/i

/**
 * Console line under the E18.1 rules: one printable ASCII line of at most 256
 * bytes. Idle or finished printers accept any such line; while printing or
 * paused only a short tuning allow-list passes; every other state refuses.
 */
export function buildBambuConsoleLine(
  line: unknown,
  printState: unknown,
  sequenceId?: string,
) {
  if (
    typeof line !== 'string' ||
    line.trim() === '' ||
    line.length > BAMBU_MAX_CONSOLE_LINE_BYTES ||
    !/^[\x20-\x7e]+$/.test(line)
  )
    throw new BambuDetailRefused('invalid-command')
  const clean = line.trim()
  if (
    printState === 'RUNNING' ||
    printState === 'PAUSE' ||
    printState === 'PREPARE'
  ) {
    if (!TUNING_ONLY.test(clean)) throw new BambuDetailRefused('state')
  } else if (printState !== 'IDLE' && printState !== 'FINISH')
    throw new BambuDetailRefused('state')
  return gcodeLine(clean, sequenceId)
}

/** SD-card operations: file manager and timelapse, FTPS only. */
export interface BambuSdCard {
  list(
    folder: BambuSdFolder,
    signal: AbortSignal,
  ): ReturnType<typeof listFolder>
  remove(
    folder: BambuSdFolder,
    name: string,
    signal: AbortSignal,
  ): Promise<void>
  download(
    folder: BambuSdFolder,
    name: string,
    signal: AbortSignal,
  ): Promise<Buffer>
}
const listFolder = async (options: BambuListOptions, folder: BambuSdFolder) => {
  const result = await bambuFtps(options, { op: 'list', folder })
  if (result.op !== 'list') throw new Error('Unexpected FTPS result')
  return result.files
}

export function createBambuSdCard(
  options: Omit<BambuListOptions, 'signal'>,
): BambuSdCard {
  return {
    list: (folder, signal) => listFolder({ ...options, signal }, folder),
    async remove(folder, name, signal) {
      await bambuFtps({ ...options, signal }, { op: 'delete', folder, name })
    },
    async download(folder, name, signal) {
      const result = await bambuFtps(
        { ...options, signal },
        { op: 'download', folder, name },
      )
      if (result.op !== 'download') throw new Error('Unexpected FTPS result')
      return result.data
    },
  }
}

export type BambuDetailQueryResult =
  { data: unknown } | { error: 'unsupported' | 'unavailable' }

/** Detail queries Bambu answers; every other kind is `unsupported`. */
export async function answerBambuDetailQuery(
  kind: QueryKind,
  sd: BambuSdCard,
  print: Readonly<Raw>,
  signal: AbortSignal,
): Promise<BambuDetailQueryResult> {
  if (kind !== 'files' && kind !== 'timelapse') return { error: 'unsupported' }
  try {
    const files = await sd.list(kind === 'files' ? 'root' : 'timelapse', signal)
    const stamp = (file: { modifiedAt: string }) => Date.parse(file.modifiedAt)
    return {
      data:
        kind === 'files'
          ? files.map((file) => ({
              path: file.name,
              bytes: file.size,
              modifiedAtMs: stamp(file),
            }))
          : {
              enabled: object(print.ipcam).timelapse === 'enable',
              rendering: false,
              files: files.map((file) => `timelapse/${file.name}`),
            },
    }
  } catch {
    return { error: 'unavailable' }
  }
}

export type BambuDetailListener = (frame: unknown) => void

/**
 * One lazy, reference-counted MQTT report connection per printer. It exists
 * only while a browser session watches. It publishes read-only status requests.
 */
export function createBambuDetailStream(input: {
  binding: BambuBinding
  sdCard?: BambuSdCard
  transport?: typeof createBambuTransport
}) {
  const binding = parseBambuBinding({
    ...input.binding,
    allowedEndpoints: [{ host: input.binding.host, port: input.binding.port }],
  })
  const listeners = new Set<BambuDetailListener>()
  const state = createBambuDetailState(binding.printerKey)
  let lifetime: AbortController | undefined
  let latest: unknown
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastUpdate = -Infinity
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let restartDelay = 1000

  const emit = (frame: unknown) => {
    for (const listener of [...listeners]) listener(frame)
  }
  function sd(): BambuSdCard {
    if (input.sdCard) return input.sdCard
    const trust = {
      ...(binding.caFile
        ? { caPem: readFileSync(binding.caFile, 'utf8') }
        : {}),
      ...(binding.pinSha256 ? { pinSha256: binding.pinSha256 } : {}),
    }
    return createBambuSdCard({
      host: binding.host,
      serial: binding.serial,
      accessCode: readBambuCredentials(binding).password,
      trust,
      port: binding.ftpsPort,
    })
  }
  function begin() {
    lifetime = new AbortController()
    start(lifetime.signal)
  }
  function start(signal: AbortSignal) {
    const publishLatest = () => {
      timer = undefined
      lastUpdate = performance.now()
      const frame = state.frame()
      if (!frame || signal.aborted) return
      latest = frame
      emit(frame)
    }
    const options = {
      host: binding.host,
      port: binding.port,
      serial: binding.serial,
      ...(binding.pinSha256 ? { pinSha256: binding.pinSha256 } : {}),
      credentials: readBambuCredentials(binding),
      ...(binding.caFile
        ? { caPem: readFileSync(binding.caFile, 'utf8') }
        : {}),
      signal,
      limits: {
        maxFrameBytes: 131072,
        connectTimeoutMs: 10000,
        maxInflight: 16,
        reconnectDelayMs: 1000,
        maxReconnects: 5,
      },
      onConnection(connection: 'connected' | 'disconnected' | 'closed') {
        if (signal.aborted) return
        if (connection === 'connected') {
          restartDelay = 1000
          return
        }
        clearTimeout(timer)
        timer = undefined
        state.reset()
        latest = state.frame()
        if (connection === 'closed' && lifetime?.signal === signal) {
          const previous = lifetime
          lifetime = undefined
          previous.abort()
          if (listeners.size && !restartTimer) {
            restartTimer = setTimeout(() => {
              restartTimer = undefined
              if (listeners.size && !lifetime) begin()
            }, restartDelay)
            restartDelay = Math.min(restartDelay * 2, 30000)
          }
        }
        if (latest) emit(latest)
      },
      onReport(payload: Buffer) {
        if (signal.aborted || !state.ingest(payload) || timer) return
        const wait = DETAIL_MIN_INTERVAL_MS - (performance.now() - lastUpdate)
        timer = setTimeout(publishLatest, Math.max(0, Math.ceil(wait)))
      },
    }
    void (input.transport ?? createBambuTransport)(options).done.catch(() => {})
  }
  return {
    subscribe(listener: BambuDetailListener) {
      listeners.add(listener)
      if (!lifetime && !restartTimer) begin()
      if (latest) listener(latest)
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        listeners.delete(listener)
        if (listeners.size) return
        clearTimeout(timer)
        timer = undefined
        clearTimeout(restartTimer)
        restartTimer = undefined
        restartDelay = 1000
        lifetime?.abort()
        lifetime = undefined
        latest = undefined
        state.reset()
      }
    },
    get active() {
      return lifetime !== undefined
    },
    query(kind: QueryKind, signal: AbortSignal) {
      return answerBambuDetailQuery(kind, sd(), state.print, signal)
    },
  }
}
export type BambuDetailStream = ReturnType<typeof createBambuDetailStream>
