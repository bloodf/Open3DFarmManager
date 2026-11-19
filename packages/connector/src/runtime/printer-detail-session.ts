import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import {
  createPrinterDetailSubscriptions,
  decodePrinterDetailFrame,
  encodePrinterDetailFrames,
  PrinterDetailQueryResponse,
  type PrinterDetailQueryRequest,
} from '../../../farm-protocol/src/printer-detail.ts'
import type { AgentRuntimeConfig } from '../config/runtime.ts'
import { validateMoonrakerInput } from '../config/moonraker.ts'
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

const MAX_ITEMS = 256
const MAX_QUERIES_PER_SESSION = 4
const METHOD_NOT_FOUND = -32601

export type PrinterDetailSourceFor = (
  printerKey: string,
) => MoonrakerDetailStream | undefined

/** One lazy stream per Moonraker assignment; nothing connects until subscribed. */
export function createPrinterDetailSources(
  config: AgentRuntimeConfig,
): PrinterDetailSourceFor {
  const sources = new Map<string, MoonrakerDetailStream>()
  const { printers, limits, allowedOrigins } = config.collection
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
  return (printerKey) => sources.get(printerKey)
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

type Query = z.infer<typeof PrinterDetailQueryRequest>

async function answer(
  frame: Query,
  source: MoonrakerDetailStream,
  signal: AbortSignal,
) {
  const { path: _path, ...rest } = frame as Query & { path?: string }
  const base = { ...rest, t: 'query.response' as const }
  try {
    const data = await query(frame, source, signal)
    return PrinterDetailQueryResponse.parse({ ...base, data })
  } catch (error) {
    const reason =
      error instanceof RangeError
        ? 'too-large'
        : error instanceof MoonrakerRpcError && error.code === METHOD_NOT_FOUND
          ? 'unsupported'
          : 'unavailable'
    return PrinterDetailQueryResponse.parse({ ...base, error: reason })
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
  { request, readConfig }: MoonrakerDetailStream,
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
