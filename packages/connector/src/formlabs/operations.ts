import { isIP } from 'node:net'
import { posix, win32 } from 'node:path'
import { z } from 'zod'
import { isLocalFormlabsHost } from './index.ts'

/**
 * Documented operations of the PreForm API v1.0.0-alpha.1.
 * Reference: https://developer.formlabs.com/api-reference/
 * OpenAPI: https://developer.formlabs.com/reference/openapi-v1.yml
 * Not wired to the Connector command pipeline; evidence and gaps are in
 * docs/fullfarmmanager/evidence/formlabs.md.
 */
const SPEC = 'https://developer.formlabs.com/reference/openapi-v1.yml'
const DEVICES = 'https://developer.formlabs.com/api-reference/devices/'
const CATALOG = 'https://formlabs.com/support/quick-start-guide-form-studio-1/'

export type FormlabsFamily = 'form-4' | 'form-3'

/**
 * The spec titles two device shapes "Form 4 or Form 4L" and "Form 3 or Form 3L".
 * Only "Form 4" appears as a `product_name` example; the other strings are
 * unverified, so any different spelling is refused. "Form 3+" is assumed to use
 * the Form 3 shape. Source: DEVICES.
 */
export function formlabsFamily(model: string): FormlabsFamily | undefined {
  const name = model.trim()
  if (/^form 4l?$/i.test(name)) return 'form-4'
  if (/^form 3(\+|l)?$/i.test(name)) return 'form-3'
  return undefined
}

export type FormlabsOperation =
  | 'status'
  | 'upload'
  | 'start'
  | 'job-list'
  | 'start-queued-job'
  | 'cancel'
  | 'pause'
  | 'resume'
  | 'discover'
  | 'upload-firmware'

const SUPPORTED: Partial<Record<FormlabsOperation, string>> = {
  status: DEVICES,
  // POST /v1/scene/print/ with print_now false queues; true starts.
  upload: SPEC,
  start: SPEC,
}
const UNSUPPORTED: Partial<
  Record<FormlabsOperation, { detail: string; source: string }>
> = {
  'job-list': {
    detail:
      'No route lists printer jobs or queues; /v1/operation/list/ lists server operations.',
    source: SPEC,
  },
  'start-queued-job': {
    detail:
      'No route starts a queued job; print_now applies only to the job being uploaded.',
    source: SPEC,
  },
  cancel: { detail: 'No route cancels a print or a job.', source: SPEC },
  pause: { detail: 'No route pauses a print.', source: SPEC },
  resume: { detail: 'No route resumes a print.', source: SPEC },
  discover: {
    detail:
      'POST /v1/device/discover/ is documented; the Connector only reads the configured device.',
    source: DEVICES,
  },
  'upload-firmware': {
    detail:
      'POST /v1/device/upload-firmware/ is documented; the Connector never changes firmware.',
    source: DEVICES,
  },
}

export function formlabsOperationSupport(
  model: string,
  operation: string,
):
  | { supported: true; source: string }
  | {
      supported: false
      reason: 'unsupported-model' | 'unsupported-operation'
      detail: string
      source: string
    } {
  if (!formlabsFamily(model))
    return {
      supported: false,
      reason: 'unsupported-model',
      detail: 'No device schema is verified for this model.',
      source: /studio/i.test(model) ? CATALOG : DEVICES,
    }
  const key = operation as FormlabsOperation
  if (Object.hasOwn(SUPPORTED, key))
    return { supported: true, source: SUPPORTED[key]! }
  const refused = Object.hasOwn(UNSUPPORTED, key)
    ? UNSUPPORTED[key]!
    : { detail: 'The operation is not documented.', source: SPEC }
  return { supported: false, reason: 'unsupported-operation', ...refused }
}

export type FormlabsRefusal =
  | 'unsupported-operation'
  | 'unsupported-model'
  | 'device-not-found'
  | 'not-local-connection'
  | 'schema-mismatch'
  | 'not-ready'
  | 'printer-busy'
  | 'host-not-loopback'
  | 'invalid-file'
  | 'invalid-job-name'
  | 'multiple-scenes'
  | 'incompatible-scene'
  | 'host-rejected'
  | 'host-unavailable'
  | 'operation-in-flight'

/** `refused`: no job reached the printer. */
export type FormlabsRefused = {
  ok: false
  outcome: 'refused'
  reason: FormlabsRefusal
  detail?: string
  source?: string
  code?: string
}
/** `uncertain`: the print request left and its effect is unknown. Never resent. */
export type FormlabsUncertain = {
  ok: false
  outcome: 'uncertain'
  reason: 'no-usable-response' | 'host-error' | 'start-not-reported'
  code?: string
  jobId?: string
}
export type FormlabsUploadResult =
  /**
   * The host acknowledged a queued upload. The API reports no printer queue, so
   * nothing can confirm that the job is on the printer.
   */
  | { ok: true; outcome: 'accepted'; jobId: string; confirmation: 'none' }
  | FormlabsRefused
  | FormlabsUncertain
export type FormlabsStartResult =
  /**
   * A later device read reported time remaining on a printer that was idle. The
   * API reports no job id, so this does not identify which job is printing.
   */
  | {
      ok: true
      outcome: 'printing'
      jobId: string
      remainingMs: number
      confirmation: 'host-status'
    }
  | FormlabsRefused
  | FormlabsUncertain

// Source: DEVICES. Cartridge entry keys are camelCase in the published schema.
const Cartridge = z.object({
  cartridgeMaterialCode: z.string().max(64),
  cartridgeEstimatedVolumeDispensed_mL: z.number().nonnegative(),
  cartridgeOriginalVolume_mL: z.number().nonnegative(),
})
const Device = z.object({
  id: z.string().min(1).max(128),
  product_name: z.string().min(1).max(128),
  status: z.string().max(256),
  is_connected: z.boolean(),
  connection_type: z.string().max(32),
  firmware_version: z.string().max(128),
  ready_to_print_now: z.boolean().optional(),
  is_remote_print_enabled: z.boolean().optional(),
  estimated_print_time_remaining_ms: z.number().int().nonnegative().optional(),
  tank_id: z.string().max(128).optional(),
  tank_material_code: z.string().max(64).optional(),
  cartridge_data: z.record(z.string().max(128), Cartridge).optional(),
  form_auto_status: z.string().max(256).optional(),
})
const DeviceList = z.object({
  count: z.number().int().nonnegative(),
  devices: z.array(z.unknown()).max(256),
})
const DeviceId = z.object({ id: z.string() })
const PrinterTypes = z.object({
  printer_types: z
    .array(
      z.object({
        supported_machine_type_ids: z.array(z.string()).max(64),
      }),
    )
    .max(64),
})
const OpenedForm = z.object({
  scenes: z
    .array(
      z.object({
        scene_id: z.string().min(1).max(128),
        scene_settings: z.object({ machine_type: z.string().min(1).max(64) }),
      }),
    )
    .max(256),
})
const Printed = z.object({ job_id: z.string().min(1).max(256) })
const HostError = z.object({
  error: z.object({ code: z.string().regex(/^[A-Z_]{1,64}$/) }),
})

/**
 * Codes that mean the print request was not acted on: request validation, and
 * PAYLOAD_TOO_LARGE ("the request has no effect"). OPERATION_FAILED also covers
 * a failed upload, so it stays uncertain. Source: SPEC, ErrorCode.
 */
const NOT_APPLIED = new Set([
  'JSON_PARSE_ERROR',
  'JSON_SCHEMA_MATCH_ERROR',
  'MISSING_PARAMETER',
  'INPUT_ERROR',
  'INVALID_QUERY_PARAMETER',
  'PAYLOAD_TOO_LARGE',
])
// USB/WIFI/ETHERNET are direct; UNKNOWN is "connected locally". Source: DEVICES.
const LOCAL_CONNECTIONS = new Set(['USB', 'WIFI', 'ETHERNET', 'UNKNOWN'])

class Refusal extends Error {
  readonly reason: FormlabsRefusal
  readonly code: string | undefined
  constructor(reason: FormlabsRefusal, code?: string) {
    super(reason)
    this.reason = reason
    this.code = code
  }
}

async function readBounded(response: Response, limit: number) {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > limit) throw Error('PreForm response too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function connectFormlabsOperations(input: {
  host: string
  port: number
  deviceId: string
  timeoutMs?: number
  /** The server's own limit for a blocking call is 10 minutes. Source: SPEC. */
  longTimeoutMs?: number
  /** Read-only checks after a start. The print request itself is sent once. */
  confirmReads?: number
  confirmIntervalMs?: number
  now?: () => number
}) {
  if (
    !isLocalFormlabsHost(input.host) ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535
  )
    throw Error('Invalid PreForm host')
  const base = `http://${isIP(input.host) === 6 ? `[${input.host}]` : input.host}:${input.port}`
  // File paths refer to the server's machine, which must be this one. Source: SPEC.
  const loopback = input.host === '::1' || input.host.startsWith('127.')
  const now = input.now ?? Date.now
  const quick = input.timeoutMs ?? 5000
  const long = input.longTimeoutMs ?? 600_000
  let inFlight = false

  async function send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    timeout: number,
  ) {
    const response = await fetch(base + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    })
    // A compatible_with catalog lists every material for one printer type.
    const text = await readBounded(response, 4 * 1024 * 1024)
    return { status: response.status, text }
  }
  function errorCode(text: string) {
    try {
      return HostError.parse(JSON.parse(text)).error.code
    } catch {
      return undefined
    }
  }
  /** For requests that send nothing to a printer. */
  async function prepare<T>(
    schema: z.ZodType<T>,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeout: number,
  ): Promise<T> {
    let reply
    try {
      reply = await send(method, path, body, timeout)
    } catch {
      throw new Refusal('host-unavailable')
    }
    if (reply.status !== 200)
      throw new Refusal('host-rejected', errorCode(reply.text))
    try {
      return schema.parse(JSON.parse(reply.text))
    } catch {
      throw new Refusal('host-unavailable')
    }
  }

  /** Only the configured entry is validated; other entries may differ. */
  async function readDevice() {
    // Disconnected devices are not listed. Source: DEVICES.
    const list = await prepare(
      DeviceList,
      'GET',
      '/v1/device/list/',
      undefined,
      quick,
    )
    if (list.count !== list.devices.length)
      throw new Refusal('host-unavailable')
    const matches = list.devices.filter(
      (entry) => DeviceId.safeParse(entry).data?.id === input.deviceId,
    )
    if (matches.length > 1) throw new Refusal('host-unavailable')
    const parsed = Device.safeParse(matches[0])
    if (!matches.length || (parsed.success && !parsed.data.is_connected))
      throw new Refusal('device-not-found')
    if (!parsed.success) throw new Refusal('schema-mismatch')
    const device = parsed.data
    const family = formlabsFamily(device.product_name)
    if (!family) throw new Refusal('unsupported-model')
    // The two families differ by form_auto_status. Source: DEVICES.
    if (
      device.estimated_print_time_remaining_ms === undefined ||
      device.ready_to_print_now === undefined ||
      device.is_remote_print_enabled === undefined ||
      device.tank_id === undefined ||
      device.tank_material_code === undefined ||
      device.cartridge_data === undefined ||
      (device.form_auto_status !== undefined) !== (family === 'form-3')
    )
      throw new Refusal('schema-mismatch')
    return {
      id: device.id,
      model: device.product_name,
      family,
      /** Human-readable text; the maker says never to match on its value. */
      statusText: device.status,
      connectionType: device.connection_type,
      firmwareVersion: device.firmware_version,
      readyToPrintNow: device.ready_to_print_now,
      remotePrintEnabled: device.is_remote_print_enabled,
      /** 0 when no print is running. It does not establish an idle state. */
      remainingMs: device.estimated_print_time_remaining_ms,
      tankId: device.tank_id,
      tankMaterialCode: device.tank_material_code,
      cartridges: Object.entries(device.cartridge_data).map(([id, data]) => ({
        id,
        materialCode: data.cartridgeMaterialCode,
        estimatedDispensedMl: data.cartridgeEstimatedVolumeDispensed_mL,
        originalMl: data.cartridgeOriginalVolume_mL,
      })),
      formAutoStatusText: device.form_auto_status,
      retrievedAt: now(),
      /** The API gives no printer observation time. */
      printerObservedAt: null,
    }
  }

  async function writableDevice(startNow: boolean) {
    const device = await readDevice()
    if (!LOCAL_CONNECTIONS.has(device.connectionType))
      throw new Refusal('not-local-connection')
    if (startNow) {
      if (device.remainingMs > 0) throw new Refusal('printer-busy')
      if (!device.readyToPrintNow) throw new Refusal('not-ready')
    }
    return device
  }

  function refused(reason: FormlabsRefusal, code?: string): FormlabsRefused {
    return {
      ok: false,
      outcome: 'refused',
      reason,
      ...(code ? { code } : {}),
    }
  }

  /** The only request that reaches a printer. It is sent at most once. */
  async function printOnce(
    sceneId: string,
    jobName: string,
    startNow: boolean,
  ): Promise<
    { ok: true; jobId: string } | FormlabsRefused | FormlabsUncertain
  > {
    const uncertain = (
      reason: FormlabsUncertain['reason'],
      code?: string,
    ): FormlabsUncertain => ({
      ok: false,
      outcome: 'uncertain',
      reason,
      ...(code ? { code } : {}),
    })
    let reply
    try {
      // print_now is always explicit: omitting it may start the print.
      reply = await send(
        'POST',
        '/v1/scene/print/',
        {
          scene_id: sceneId,
          printer: input.deviceId,
          job_name: jobName,
          print_now: startNow,
        },
        long,
      )
    } catch {
      return uncertain('no-usable-response')
    }
    if (reply.status !== 200) {
      const code = errorCode(reply.text)
      if (reply.status < 500 && code && NOT_APPLIED.has(code))
        return refused('host-rejected', code)
      return uncertain('host-error', code)
    }
    try {
      return { ok: true, jobId: Printed.parse(JSON.parse(reply.text)).job_id }
    } catch {
      return uncertain('no-usable-response')
    }
  }

  /** Scenes live in server memory; a failed delete changes no printer. */
  async function discard(sceneIds: string[]) {
    for (const scene_id of sceneIds)
      await send('DELETE', '/v1/scene/delete/', { scene_id }, quick).catch(
        () => undefined,
      )
  }

  async function submit(
    request: { file: string; jobName: string },
    startNow: boolean,
  ) {
    if (!loopback) return refused('host-not-loopback')
    const { file, jobName } = request
    // /v1/scene/open/ accepts only .form, on the server's filesystem.
    if (
      !(posix.isAbsolute(file) || win32.isAbsolute(file)) ||
      !/\.form$/i.test(file) ||
      file.length > 1024 ||
      /\p{Cc}/u.test(file)
    )
      return refused('invalid-file')
    if (!jobName.trim() || jobName.length > 128 || /\p{Cc}/u.test(jobName))
      return refused('invalid-job-name')
    if (inFlight) return refused('operation-in-flight')
    inFlight = true
    let sceneIds: string[] = []
    let keepScenes = false
    try {
      await writableDevice(startNow)
      // compatible_with returns only this printer's type. Source: SPEC.
      const compatible = await prepare(
        PrinterTypes,
        'POST',
        '/v1/print-setting/list/',
        { compatible_with: input.deviceId },
        quick,
      )
      const { scenes } = await prepare(
        OpenedForm,
        'POST',
        '/v1/scene/open/',
        { file },
        long,
      )
      sceneIds = scenes.map((scene) => scene.scene_id)
      const [scene] = scenes
      if (!scene || scenes.length !== 1) return refused('multiple-scenes')
      if (
        !compatible.printer_types.some((type) =>
          type.supported_machine_type_ids.includes(
            scene.scene_settings.machine_type,
          ),
        )
      )
        return refused('incompatible-scene')
      // Opening a large file takes time, so gate again before sending.
      await writableDevice(startNow)
      const sent = await printOnce(scene.scene_id, jobName, startNow)
      if (!sent.ok && sent.outcome === 'uncertain') keepScenes = true
      return { sent }
    } catch (error) {
      if (error instanceof Refusal) return refused(error.reason, error.code)
      throw error
    } finally {
      // An unanswered print may still use the scene; leave it in place.
      if (!keepScenes) await discard(sceneIds)
      inFlight = false
    }
  }

  return {
    /** GET /v1/device/list/. Rejects when the device cannot be read. */
    status: readDevice,
    /** Upload a .form job to the printer's queue without starting it. */
    async upload(request: {
      file: string
      jobName: string
    }): Promise<FormlabsUploadResult> {
      const result = await submit(request, false)
      if ('ok' in result) return result
      if (!result.sent.ok) return result.sent
      return {
        ok: true,
        outcome: 'accepted',
        jobId: result.sent.jobId,
        confirmation: 'none',
      }
    },
    /** Upload a .form job and start it, on a printer that reports ready. */
    async start(request: {
      file: string
      jobName: string
    }): Promise<FormlabsStartResult> {
      const result = await submit(request, true)
      if ('ok' in result) return result
      if (!result.sent.ok) return result.sent
      const { jobId } = result.sent
      for (let read = 0; read < (input.confirmReads ?? 5); read++) {
        if (read)
          await new Promise((resolve) =>
            setTimeout(resolve, input.confirmIntervalMs ?? 2000),
          )
        const device = await readDevice().catch(() => undefined)
        if (device && device.remainingMs > 0)
          return {
            ok: true,
            outcome: 'printing',
            jobId,
            remainingMs: device.remainingMs,
            confirmation: 'host-status',
          }
      }
      return {
        ok: false,
        outcome: 'uncertain',
        reason: 'start-not-reported',
        jobId,
      }
    },
    /** Every operation without a documented, implemented route. Sends nothing. */
    refuse(
      model: string,
      operation: Exclude<FormlabsOperation, 'status' | 'upload' | 'start'>,
    ): FormlabsRefused {
      const support = formlabsOperationSupport(model, operation)
      if (support.supported) throw Error('Operation is supported')
      const { reason, detail, source } = support
      return { ok: false, outcome: 'refused', reason, detail, source }
    },
  }
}
