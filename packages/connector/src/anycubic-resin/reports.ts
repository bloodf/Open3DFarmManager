// Decoder for Photon P1 Max (model ID 132) LAN reports. Field names and states
// follow the captures listed in `photonP1MaxSources` (models.ts). Anything the
// captures do not show stays unknown.

export type PhotonResinJobPhase =
  'copying' | 'printing' | 'waiting' | 'stopped' | 'unknown'

export type PhotonResinJob = {
  phase: PhotonResinJobPhase
  reportedState: string
  taskId: string | null
  filename: string | null
  /** Copy from the USB stick, not print progress. */
  copyProgressPercent: number | null
  progressPercent: number | null
  layer: number | null
  totalLayers: number | null
  /** `supplies_usage`: the whole job's estimate, already present at layer 0. */
  estimatedVolumeMl: number | null
  code: number | null
  observedAt: number
}

export type PhotonResinFile = {
  name: string
  directory: boolean
  sizeBytes: number | null
}

export type PhotonResinReadings = {
  printer: {
    activity: 'free' | 'unknown'
    reportedState: string
    observedAt: number
  } | null
  job: PhotonResinJob | null
  resinTemperature: { celsius: number; observedAt: number } | null
  /** Wear counter for the release film. It does not measure resin. */
  releaseFilm: {
    times: number
    layers: number
    status: number
    observedAt: number
  } | null
  peripherals: {
    camera: boolean
    usbDisk: boolean
    smartResinVat: boolean
    airPurifier: boolean
    observedAt: number
  } | null
  localFiles: { entries: PhotonResinFile[]; observedAt: number } | null
  cameraStreaming: boolean | null
}

export type PhotonResinReport = {
  type: string
  action: string
  state: string
  code: number | null
  data: Record<string, unknown> | null
}

export function emptyPhotonResinReadings(): PhotonResinReadings {
  return {
    printer: null,
    job: null,
    resinTemperature: null,
    releaseFilm: null,
    peripherals: null,
    localFiles: null,
    cameraStreaming: null,
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, limit = 255): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null
}

function bounded(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && value >= min && value <= max
    ? value
    : null
}

function count(value: unknown): number | null {
  const number = bounded(value, 0, Number.MAX_SAFE_INTEGER)
  return number !== null && Number.isInteger(number) ? number : null
}

function flag(value: unknown): boolean | null {
  return value === 0 || value === 1 ? value === 1 : null
}

export function parsePhotonResinReport(
  payload: Buffer,
): PhotonResinReport | undefined {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    return
  }
  if (!record(value)) return
  const type = text(value.type, 64)
  const action = text(value.action, 64)
  if (!type || !action) return
  return {
    type,
    action,
    state: text(value.state, 64) ?? '',
    code: count(value.code),
    data: record(value.data) ? value.data : null,
  }
}

function jobPhase(
  report: PhotonResinReport,
): PhotonResinJobPhase | 'unchanged' {
  const { action, state } = report
  // Pre-print checklists, and the two captured refusals, change no job.
  if (
    state === 'monitoring' ||
    (action === 'pause' && state === 'unablePause') ||
    (action === 'resume' && state === 'unable-resume')
  )
    return 'unchanged'
  if (action === 'start' && state === 'copying') return 'copying'
  if (action === 'start' && state === 'printing') return 'printing'
  if (action === 'start' && state === 'waiting') return 'waiting'
  if ((action === 'start' || action === 'stop') && state === 'stoped')
    return 'stopped'
  return 'unknown'
}

function nextJob(
  previous: PhotonResinJob | null,
  report: PhotonResinReport,
  observedAt: number,
): PhotonResinJob | null {
  const phase = jobPhase(report)
  const data = report.data
  if (phase === 'unchanged' || !data) return previous
  const taskId = text(data.taskid, 64)
  const filename = text(data.filename)
  // Copying uses task "-1" before the printer assigns the job's own ID.
  const same =
    previous !== null &&
    previous.phase !== 'stopped' &&
    phase !== 'copying' &&
    (!filename || !previous.filename || filename === previous.filename) &&
    (!taskId ||
      !previous.taskId ||
      previous.taskId === '-1' ||
      taskId === previous.taskId)
  const kept = same ? previous : null
  const progress = bounded(data.progress, 0, 100)
  return {
    phase,
    reportedState: report.state,
    taskId: taskId ?? kept?.taskId ?? null,
    filename: filename ?? kept?.filename ?? null,
    copyProgressPercent: phase === 'copying' ? progress : null,
    progressPercent:
      phase === 'copying' ? null : (progress ?? kept?.progressPercent ?? null),
    layer: count(data.curr_layer) ?? kept?.layer ?? null,
    totalLayers: count(data.total_layers) ?? kept?.totalLayers ?? null,
    estimatedVolumeMl:
      bounded(data.supplies_usage, 0, 100_000) ??
      kept?.estimatedVolumeMl ??
      null,
    code: report.code,
    observedAt,
  }
}

function files(value: unknown): PhotonResinFile[] | undefined {
  if (!Array.isArray(value) || value.length > 1000) return
  const entries: PhotonResinFile[] = []
  for (const item of value) {
    if (!record(item)) return
    const name = text(item.filename)
    if (!name || typeof item.is_dir !== 'boolean') return
    entries.push({ name, directory: item.is_dir, sizeBytes: count(item.size) })
  }
  return entries
}

/** The three captured replies to `stopCapture`, plus the push-ended notice. */
export function photonCameraStopped(report: PhotonResinReport) {
  return (
    report.type === 'video' &&
    report.action === 'stopCapture' &&
    ((report.state === 'done' && report.code === 200) ||
      (report.state === 'initSuccess' && report.code === 1404))
  )
}

/** Applies a report. Returns false when it carried no usable reading. */
export function applyPhotonResinReport(
  readings: PhotonResinReadings,
  report: PhotonResinReport,
  observedAt: number,
): boolean {
  const data = report.data
  switch (report.type) {
    case 'status': {
      if (!report.state || report.code !== 200) return false
      readings.printer = {
        activity: report.state === 'free' ? 'free' : 'unknown',
        reportedState: report.state,
        observedAt,
      }
      return true
    }
    case 'print': {
      const job = nextJob(readings.job, report, observedAt)
      if (job === readings.job) return false
      readings.job = job
      return true
    }
    case 'properties': {
      const celsius = bounded(data?.resin_temp, -20, 120)
      if (celsius === null) return false
      readings.resinTemperature = { celsius, observedAt }
      return true
    }
    case 'releaseFilm': {
      const times = count(data?.times)
      const layers = count(data?.layers)
      const status = count(data?.status)
      if (times === null || layers === null || status === null) return false
      readings.releaseFilm = { times, layers, status, observedAt }
      return true
    }
    case 'peripherie': {
      const camera = flag(data?.camera)
      const usbDisk = flag(data?.udisk)
      const smartResinVat = flag(data?.smartResinVat)
      const airPurifier = flag(data?.airpure)
      if (
        camera === null ||
        usbDisk === null ||
        smartResinVat === null ||
        airPurifier === null
      )
        return false
      readings.peripherals = {
        camera,
        usbDisk,
        smartResinVat,
        airPurifier,
        observedAt,
      }
      return true
    }
    case 'file': {
      if (report.action !== 'listLocal' || report.code !== 200) return false
      const entries = files(data?.records)
      if (!entries) return false
      readings.localFiles = { entries, observedAt }
      return true
    }
    case 'video': {
      if (
        report.action === 'startCapture' &&
        report.state === 'initSuccess' &&
        report.code === 200
      )
        readings.cameraStreaming = true
      // https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/docs/protocol.md#lifecycle
      else if (photonCameraStopped(report)) readings.cameraStreaming = false
      else return false
      return true
    }
    default:
      return false
  }
}
