import { record } from './discovery.ts'
import {
  noGuard,
  runGated,
  type KobraXCall,
  type KobraXControlContext,
} from './context.ts'
import { kobraXGate } from './gate.ts'
import { kobraXPrintSlots } from './facts.ts'
import {
  refusedLocally,
  reportRefusal,
  type KobraXOutcome,
  type KobraXReport,
} from './requests.ts'

export interface KobraXFile {
  filename: string
  sizeBytes?: number
  /** Milliseconds since the epoch; `listLocal` reports milliseconds. */
  modifiedAtMs?: number
}

export interface KobraXFileDetails {
  filename: string
  sizeBytes?: number
  layers?: number
  printTimeSeconds?: number
}

export interface KobraXStartOptions {
  /** A file that is already on the printer, for example from `upload`. */
  filename: string
  /** Filament (as numbered by the slicer) to native feeder slot. */
  slotMapping?: readonly { filament: number; slot: number }[]
  /** Explicit signed mapping is ambiguous when the printer reports only ACE. */
  requireReportedHolder?: boolean
  settings?: {
    autoLeveling?: boolean
    vibrationCompensation?: boolean
    flowCalibration?: boolean
    timelapse?: boolean
  }
  /** How long to watch `print/report` for a printer-ended task. */
  watchMs?: number
}

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
const FILE_NAME = /^[^\\/\x00-\x1f\x7f%]{1,255}$/
const FILE_EXTENSION = /\.(?:gcode|3mf)$/i

export function validKobraXFilename(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    FILE_NAME.test(name) &&
    !name.includes('..') &&
    FILE_EXTENSION.test(name)
  )
}

function bounded(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function parseFiles(report: KobraXReport): KobraXFile[] {
  const records = report.data.records
  if (!Array.isArray(records)) return []
  return records.slice(0, 500).flatMap((value) => {
    const item = record(value)
    if (typeof item.filename !== 'string' || !item.filename) return []
    const size = bounded(item.size)
    const modified = bounded(item.timestamp)
    return [
      {
        filename: item.filename.slice(0, 255),
        ...(size !== undefined ? { sizeBytes: size } : {}),
        ...(modified !== undefined ? { modifiedAtMs: modified } : {}),
      },
    ]
  })
}

export function createKobraXFiles(context: KobraXControlContext) {
  function list(call?: KobraXCall): Promise<KobraXOutcome<KobraXFile[]>> {
    return runGated(context, { action: 'file-list' }, call, {
      type: 'file',
      action: 'listLocal',
      data: { root: '/' },
      result: parseFiles,
    })
  }

  function details(
    filename: string,
    call?: KobraXCall,
  ): Promise<KobraXOutcome<KobraXFileDetails>> {
    if (!validKobraXFilename(filename)) return refuse('invalid-filename')
    return runGated(context, { action: 'file-details', filename }, call, {
      type: 'file',
      action: 'fileDetails',
      data: { root: '/', filename },
      // Other clients poll the same topic: only the reply for this file counts.
      accept: (report) => report.data.filename === filename,
      result(report) {
        const info = record(report.data.file_details)
        const size = bounded(info.size)
        const layers = bounded(info.layers)
        const time = bounded(info.print_time)
        return {
          filename,
          ...(size !== undefined ? { sizeBytes: size } : {}),
          ...(layers !== undefined ? { layers } : {}),
          ...(time !== undefined ? { printTimeSeconds: time } : {}),
        }
      },
    })
  }

  function remove(filename: string, call: KobraXCall) {
    if (!validKobraXFilename(filename)) return refuse('invalid-filename')
    return runGated(context, { action: 'file-delete', filename }, call, {
      type: 'file',
      action: 'deleteLocal',
      data: { root: '/', filename },
      accept: (report) => report.data.filename === filename,
    })
  }

  /** Upload over `POST /gcode_upload`. The upload is the single send of this command. */
  async function upload(
    input: { filename: string; content: Blob },
    call: KobraXCall,
  ): Promise<KobraXOutcome<{ filename: string }>> {
    if (!validKobraXFilename(input.filename)) return refuse('invalid-filename')
    if (input.content.size === 0 || input.content.size > MAX_UPLOAD_BYTES)
      return refuse('invalid-size')
    const reason = kobraXGate({
      action: 'upload',
      state: context.state(),
      facts: context.facts.get(),
    })
    if (reason) return refuse(reason)
    const release = context.claim()
    if (!release) return refuse('busy')
    try {
      const form = new FormData()
      form.append('file', input.content, input.filename)
      const url = new URL('/gcode_upload', `http://${context.address}`)
      url.port = String(context.httpPort)
      url.searchParams.set('s', context.token)
      let allowed = false
      try {
        allowed = call.beforeSend() === true
      } catch {
        allowed = false
      }
      if (!allowed) return refuse('not-authorized')
      const signal = AbortSignal.any([
        AbortSignal.timeout(120_000),
        ...(call.signal ? [call.signal] : []),
      ])
      let response: Response
      try {
        response = await (context.fetch ?? fetch)(url, {
          method: 'POST',
          body: form,
          redirect: 'error',
          signal,
        })
      } catch {
        return { kind: 'unanswered' }
      }
      const text = await readSmallText(response)
      let body: Record<string, unknown> = {}
      try {
        body = record(JSON.parse(text))
      } catch {
        // An unreadable body leaves the upload without a result.
      }
      const code = typeof body.code === 'number' ? body.code : undefined
      if (response.status >= 400 || (code !== undefined && code !== 200))
        return {
          kind: 'refused',
          stage: 'printer',
          reason: 'upload-refused',
          code: code ?? response.status,
        }
      const stored = record(body.data).gcode
      if (response.status === 200 && code === 200 && typeof stored === 'string')
        return {
          kind: 'confirmed',
          report: {
            type: 'http',
            action: 'gcode_upload',
            msgid: '',
            state: 'done',
            code: 200,
            data: {},
          },
          data: { filename: stored.slice(0, 255) },
        }
      return { kind: 'received' }
    } finally {
      release()
    }
  }

  /**
   * `print/start` with `filepath: "/"`. A start report alone is not proof: the
   * printer may end the task about a second later, so `print/report` is
   * watched for `watchMs` before the job counts as running.
   */
  async function start(
    options: KobraXStartOptions,
    call: KobraXCall,
  ): Promise<KobraXOutcome<{ filename: string }>> {
    if (!validKobraXFilename(options.filename))
      return refuse('invalid-filename')
    const facts = context.facts.get()
    const mapping = options.slotMapping ?? []
    const slotsAvailable = ({ boxes }: typeof facts) => {
      if (options.requireReportedHolder && !boxes.some((box) => box.id === -1))
        return false
      const slots = kobraXPrintSlots(boxes)
      return mapping.every(
        (entry) =>
          slots.filter(
            ({ amsIndex, slot }) =>
              amsIndex === entry.slot && slot.remainingPercent !== 0,
          ).length === 1,
      )
    }
    const filaments = new Set<number>()
    for (const entry of mapping) {
      if (
        !Number.isInteger(entry.filament) ||
        entry.filament < 0 ||
        entry.filament > 15 ||
        filaments.has(entry.filament)
      )
        return refuse('invalid-slot-mapping')
      filaments.add(entry.filament)
    }
    if (!slotsAvailable(facts)) return refuse('unknown-slot')
    const supported = (feature: string) => facts.features[feature] !== false
    const settings = options.settings ?? {}
    const flag = (value: boolean) => (value ? 1 : 0)
    const taskSettings: Record<string, unknown> = {
      auto_leveling: flag(settings.autoLeveling ?? true),
      ...(settings.vibrationCompensation !== undefined &&
      supported('vibration_compensation_support')
        ? { vibration_compensation: flag(settings.vibrationCompensation) }
        : {}),
      ...(settings.flowCalibration !== undefined &&
      supported('flow_calibration_support')
        ? { flow_calibration: flag(settings.flowCalibration) }
        : {}),
      ...(settings.timelapse !== undefined &&
      supported('camera_timelapse_support')
        ? {
            timelapse: { status: flag(settings.timelapse), count: 0, type: 64 },
          }
        : {}),
    }
    // State is gated first so a busy printer is not even asked what it stores.
    const reason = kobraXGate({
      action: 'print-start',
      state: context.state(),
      facts,
    })
    if (reason) return refuse(reason)
    const present = await list({
      ...noGuard,
      ...(call.signal ? { signal: call.signal } : {}),
    })
    if (present.kind !== 'confirmed') return refuse('file-list-unavailable')
    if (!present.data.some((file) => file.filename === options.filename))
      return refuse('file-not-on-printer')
    if (!slotsAvailable(context.facts.get())) return refuse('unknown-slot')
    const watchMs = options.watchMs ?? 5000
    let ended: KobraXReport | undefined
    const stop = context.requests.onReport((report) => {
      if (report.type === 'print' && report.state === 'stoped') ended = report
    })
    try {
      const started = await runGated(
        context,
        { action: 'print-start', filename: options.filename },
        call,
        {
          type: 'print',
          action: 'start',
          data: {
            taskid: '-1',
            filepath: '/',
            filename: options.filename,
            ...(mapping.length
              ? {
                  ams_settings: {
                    ams_box_mapping: mapping.map((entry) => ({
                      paint_index: entry.filament,
                      ams_index: entry.slot,
                    })),
                  },
                }
              : {}),
            task_settings: taskSettings,
          },
          // A job that already ended cannot confirm a start.
          effect: (report) =>
            report.state !== 'stoped' && report.state !== 'finished',
          result: () => ({ filename: options.filename }),
        },
      )
      if (started.kind !== 'confirmed') return started
      const outcome = await watchForEnd(() => ended, watchMs, call.signal)
      if (call.signal?.aborted) return { kind: 'received' }
      if (outcome) {
        const refusal = reportRefusal(outcome)
        return {
          kind: 'refused',
          stage: 'printer',
          reason: 'task-ended-by-printer',
          ...(typeof refusal === 'number' ? { code: refusal } : {}),
        }
      }
      return started
    } finally {
      stop()
    }
  }

  return { list, details, remove, upload, start }
}

function refuse(reason: string): Promise<KobraXOutcome<never>> {
  return Promise.resolve(refusedLocally(reason))
}

async function readSmallText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 16384) return ''
      chunks.push(value)
    }
  } catch {
    return ''
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString('utf8')
}

function watchForEnd(
  ended: () => KobraXReport | undefined,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<KobraXReport | undefined> {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const report = ended()
      if (report || Date.now() - started >= ms || signal?.aborted) {
        clearInterval(timer)
        resolve(report)
      }
    }, 25)
  })
}
