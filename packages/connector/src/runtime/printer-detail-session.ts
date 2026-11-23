import { anycubicPrinterDetail } from '../anycubic/printer-detail.ts'
import { kobraXPrinterDetail } from '../kobra-x/printer-detail.ts'
import type { PrinterState } from '../../../farm-protocol/src/state.ts'
import { randomUUID } from 'node:crypto'
import { parseGcodeHelp } from '../moonraker/control-console.ts'
import type { z } from 'zod'
import {
  createPrinterDetailSubscriptions,
  decodePrinterDetailFrame,
  encodePrinterDetailFrames,
  PrinterDetailStreamQueryResponse,
  type PrinterDetailStreamQueryRequest,
} from '../../../farm-protocol/src/printer-detail.ts'
import type { AgentRuntimeConfig } from '../config/runtime.ts'
import {
  moonrakerOrigins,
  validateMoonrakerInput,
} from '../config/moonraker.ts'
import {
  readDetailHistory,
  readDetailTotals,
} from '../moonraker/control-history.ts'
import {
  createMoonrakerDetailStream,
  MoonrakerRpcError,
  count,
  fields,
  fraction,
  list,
  string,
  type MoonrakerDetailStream,
} from '../moonraker/detail-stream.ts'

import {
  createBambuDetailStream,
  type BambuDetailStream,
} from '../bambu/printer-detail.ts'
import { createCrealityDetailStream } from '../creality/printer-detail.ts'

const MAX_ITEMS = 256
const MAX_QUERIES_PER_SESSION = 4
const METHOD_NOT_FOUND = -32601

export type PrinterDetailSourceFor = (
  printerKey: string,
) => PrinterDetailSource | undefined

type PrinterDetailSource = Pick<MoonrakerDetailStream, 'subscribe'> &
  Partial<Pick<MoonrakerDetailStream, 'request' | 'readConfig'>> &
  Partial<Pick<BambuDetailStream, 'query'>>

/** Moonraker, Bambu and Creality streams connect on subscription. Anycubic frames reuse collection. */
export function createPrinterDetailSources(config: AgentRuntimeConfig) {
  const sources = new Map<string, PrinterDetailSource>()
  const { printers, limits } = config.collection
  const allowedOrigins = moonrakerOrigins(config.collection)
  if (config.collection.version === 3)
    for (const binding of config.collection.bambu.printers)
      if (
        config.assignments.some(
          (item) => item.printer_key === binding.printerKey,
        )
      )
        sources.set(binding.printerKey, createBambuDetailStream({ binding }))
  for (const assignment of config.assignments) {
    if (!('moonraker_origin' in assignment) || !assignment.moonraker_origin)
      continue
    const printer = printers.find(
      (item) => item.printerKey === assignment.printer_key,
    )
    if (!printer) continue
    const selected = validateMoonrakerInput({
      assignment: printer,
      limits,
      allowedOrigins,
    })
    if (selected.origin === assignment.moonraker_origin)
      sources.set(selected.printerKey, createMoonrakerDetailStream(selected))
  }
  if (config.collection.version === 4)
    for (const assignment of config.assignments) {
      // Klipper-rooted K-series printers keep the Moonraker stream above.
      if (sources.has(assignment.printer_key)) continue
      const binding = config.collection.creality.printers.find(
        (item) => item.printerKey === assignment.printer_key,
      )
      if (!binding) continue
      const camera = config.camera?.cameras.find(
        (item) =>
          item.assignmentId === assignment.assignment_id &&
          'kind' in item.source &&
          item.source.kind === 'creality-mjpeg',
      )
      sources.set(
        binding.printerKey,
        createCrealityDetailStream(binding, { cameraId: camera?.cameraId }),
      )
    }
  const vendor = createVendorDetailSources()
  if (config.collection.version === 5) {
    for (const binding of config.collection.anycubic.printers) {
      if (!['20024', '20030'].includes(binding.modelId)) continue
      const assignment = config.assignments.find(
        ({ printer_key }) => printer_key === binding.printerKey,
      )
      const cameraId = config.camera?.cameras.find(
        ({ assignmentId }) => assignmentId === assignment?.assignment_id,
      )?.cameraId
      sources.set(
        binding.printerKey,
        vendor.register(binding.printerKey, (printer, seq) =>
          binding.modelId === '20030'
            ? kobraXPrinterDetail(printer, seq, cameraId)
            : anycubicPrinterDetail(printer, seq, { cameraId }),
        ),
      )
    }
  }
  return {
    sourceFor: (printerKey: string) => sources.get(printerKey),
    observe: vendor.observe,
    invalidate: vendor.invalidate,
  }
}

export function createVendorDetailSources() {
  const publish = new Map<string, (printer: PrinterState) => void>()
  return {
    register(
      key: string,
      frame: (printer: PrinterState, seq: number) => unknown,
    ): PrinterDetailSource {
      const listeners = new Set<(frame: unknown) => void>()
      let latest: unknown
      let seq = 0
      publish.set(key, (printer) => {
        const next = frame(printer, ++seq)
        if (!next) return
        latest = next
        for (const listener of listeners) listener(next)
      })
      return {
        subscribe(listener) {
          listeners.add(listener)
          if (latest) listener(latest)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    },
    observe(printer: PrinterState) {
      publish.get(printer.printerKey)?.(printer)
    },
    invalidate(printerKey: string) {
      publish.get(printerKey)?.({
        printerKey,
        state: 'offline',
        observedAt: Date.now(),
      })
    },
  }
}

/**
 * Per-browser detail session. Subscribing starts the shared stream for the
 * printer; unsubscribing, or closing the session, releases it.
 */
export function createPrinterDetailSession(
  sourceFor: PrinterDetailSourceFor,
  isAssigned: (printerKey: string) => boolean,
  send: (wires: string[]) => void,
) {
  const active = new Map<string, AbortController>()
  let pending = 0
  const emit = (frame: unknown) =>
    send(encodePrinterDetailFrames(frame, randomUUID()))
  const subscriptions = createPrinterDetailSubscriptions(
    (key) => isAssigned(key) && Boolean(sourceFor(key)),
    (key) => {
      const controller = new AbortController()
      active.set(key, controller)
      const stop = sourceFor(key)!.subscribe((frame) => {
        try {
          emit(frame)
        } catch {
          // An oversized or invalid frame drops only itself, not the stream.
        }
      })
      return () => {
        active.delete(key)
        controller.abort()
        stop()
      }
    },
  )
  return {
    /** Returns true when the frame belonged to the detail protocol. */
    receive(wire: string) {
      let frame
      try {
        frame = decodePrinterDetailFrame(wire)
      } catch {
        return false
      }
      if (frame.t === 'detail.subscribe' || frame.t === 'detail.unsubscribe') {
        subscriptions.receive(frame)
        return true
      }
      if (frame.t !== 'query.request') return false
      const controller = active.get(frame.printerKey)
      const source = sourceFor(frame.printerKey)
      if (!controller || !source || pending >= MAX_QUERIES_PER_SESSION)
        return true
      pending++
      void answer(frame, source, controller.signal)
        .then((reply) => {
          if (!controller.signal.aborted) emit(reply)
        })
        .catch(() => {})
        .finally(() => {
          pending--
        })
      return true
    },
    close: () => subscriptions.close(),
  }
}

type Query = z.infer<typeof PrinterDetailStreamQueryRequest>

async function answer(
  frame: Query,
  source: PrinterDetailSource,
  signal: AbortSignal,
) {
  const { path: _path, ...rest } = frame as Query & { path?: string }
  const base = { ...rest, t: 'query.response' as const }
  if (source.query) {
    const reply = await source.query(frame.kind, signal)
    return PrinterDetailStreamQueryResponse.parse({ ...base, ...reply })
  }
  try {
    if (!source.request || !source.readConfig)
      return PrinterDetailStreamQueryResponse.parse({
        ...base,
        error: 'unsupported',
      })
    const data = await query(
      frame,
      { request: source.request, readConfig: source.readConfig },
      signal,
    )
    return PrinterDetailStreamQueryResponse.parse({ ...base, data })
  } catch (error) {
    const reason =
      error instanceof RangeError
        ? 'too-large'
        : error instanceof MoonrakerRpcError && error.code === METHOD_NOT_FOUND
          ? 'unsupported'
          : 'unavailable'
    return PrinterDetailStreamQueryResponse.parse({ ...base, error: reason })
  }
}

const path = (value: unknown) => string(value, 512)
const names = (value: unknown) =>
  list(value)
    .slice(0, MAX_ITEMS)
    .map((item) => path(fields(item).path))
    .filter(Boolean)
const ms = (seconds: unknown) => count(Number(seconds) * 1000)

async function query(
  frame: Query,
  {
    request,
    readConfig,
  }: Pick<MoonrakerDetailStream, 'request' | 'readConfig'>,
  signal: AbortSignal,
) {
  switch (frame.kind) {
    case 'files':
      return list(await request('server.files.list', { root: 'gcodes' }))
        .map((item) => fields(item))
        .sort((a, b) => Number(b.modified) - Number(a.modified))
        .slice(0, MAX_ITEMS)
        .map((file) => ({
          path: path(file.path),
          bytes: count(file.size),
          modifiedAtMs: ms(file.modified),
        }))
        .filter((file) => file.path)
    case 'config-files':
      return names(await request('server.files.list', { root: 'config' }))
    case 'config-read':
      return { path: frame.path, text: await readConfig(frame.path, signal) }
    case 'history':
      return readDetailHistory(request, signal)
    case 'totals':
      return readDetailTotals(request)
    case 'job-queue': {
      const queue = fields(await request('server.job_queue.status'))
      return {
        state: string(queue.queue_state) || 'unknown',
        jobs: list(queue.queued_jobs)
          .slice(0, MAX_ITEMS)
          .map((item) => fields(item))
          .map((job) => ({ id: string(job.job_id), file: path(job.filename) }))
          .filter((job) => job.id && job.file),
      }
    }
    case 'gcode-help':
      return parseGcodeHelp(await request('printer.gcode.help'))
    case 'power-devices':
      return list(fields(await request('machine.device_power.devices')).devices)
        .slice(0, 64)
        .map((item) => fields(item))
        .map((device) => ({
          name: string(device.device),
          on: device.status === 'on',
        }))
        .filter((device) => device.name)
    case 'timelapse': {
      const settings = fields(await request('server.timelapse.get_settings'))
      const files = await request('server.files.list', { root: 'timelapse' })
      return {
        enabled: settings.enabled === true,
        rendering: settings.rendering === true,
        files: names(files),
      }
    }
    case 'update-status':
      return Object.entries(
        fields(
          fields(await request('machine.update.status', { refresh: false }))
            .version_info,
        ),
      )
        .slice(0, 64)
        .map(([name, item]) => {
          const version = fields(item)
          return {
            name: string(name),
            installed: string(version.version),
            ...(string(version.remote_version)
              ? { available: string(version.remote_version) }
              : {}),
          }
        })
        .filter((item) => item.name && item.installed)
    case 'temperature-store':
      return temperatureStore(await request('server.temperature_store'))
  }
}

/**
 * Moonraker keeps one sample per second. Keep the newest sample and stride
 * back so the whole window fits the protocol cap.
 */
function temperatureStore(store: unknown) {
  const now = Date.now()
  return Object.entries(fields(store))
    .slice(0, 64)
    .map(([name, item]) => {
      const series = fields(item)
      const temperatures = list(series.temperatures)
      const targets = list(series.targets)
      const powers = list(series.powers)
      const stride = Math.ceil(temperatures.length / MAX_ITEMS) || 1
      const samples = []
      for (let i = temperatures.length - 1; i >= 0; i -= stride) {
        const temperature = temperatures[i]
        if (typeof temperature !== 'number' || !Number.isFinite(temperature))
          continue
        const target = targets[i]
        const power = powers[i]
        samples.push({
          atMs: now - (temperatures.length - 1 - i) * 1000,
          temperature,
          ...(typeof target === 'number' && Number.isFinite(target)
            ? { target }
            : {}),
          ...(typeof power === 'number' ? { power: fraction(power) } : {}),
        })
      }
      return { name: string(name), samples: samples.reverse() }
    })
    .filter((item) => item.name)
}
