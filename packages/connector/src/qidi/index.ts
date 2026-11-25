import { uploadMoonrakerFile } from '../moonraker/upload.ts'
import { QIDI_PROFILES, type QidiModel } from './profiles.ts'

// Qidi ships a Moonraker fork. See https://github.com/QIDITECH/QIDI_Q1_Pro
// HTTP contracts: https://moonraker.readthedocs.io/en/latest/external_api/
// Q1 Pro defines its part fan as [fan_generic cooling_fan].
// https://github.com/QIDITECH/QIDI_Q1_Pro/blob/main/config/printer.cfg
// Klipper exposes its speed through get_status, read by Moonraker's object query.
// https://github.com/Klipper3d/klipper/blob/master/klippy/extras/fan_generic.py
// https://moonraker.readthedocs.io/en/latest/external_api/printer/#query-printer-object-status
const namedPartFan = 'fan_generic cooling_fan'
const baseObjects = [
  'webhooks',
  'print_stats',
  'virtual_sdcard',
  'extruder',
  'heater_bed',
] as const
// Without a provisioned model only the part fan is read.
const unboundObjects = [...baseObjects, 'fan', namedPartFan]

type Failure =
  'unauthorized' | 'unsupported' | 'timeout' | 'offline' | 'invalid-response'

export class QidiProtocolError extends Error {
  readonly reason: Failure
  constructor(reason: Failure) {
    super(`Qidi request failed: ${reason}`)
    this.name = 'QidiProtocolError'
    this.reason = reason
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new QidiProtocolError('invalid-response')
  return value as Record<string, unknown>
}

const optionalRecord = (value: unknown) =>
  value === undefined ? undefined : record(value)

export function createQidiAdapter(input: {
  origin: string
  /** Provisioned locally. Selects the model's cited Klipper objects. */
  model?: QidiModel
  auth?: { apiKey: string } | { bearerToken: string }
  snapshotPath?: string
  timeoutMs?: number
}) {
  const origin = new URL(input.origin)
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== input.origin
  )
    throw new TypeError('Expected a canonical locally configured Qidi origin')

  const snapshot = input.snapshotPath && new URL(input.snapshotPath, origin)
  if (
    snapshot &&
    (snapshot.origin !== origin.origin ||
      snapshot.username ||
      snapshot.password ||
      snapshot.hash)
  )
    throw new TypeError('Expected a same-origin Qidi snapshot URL')

  const profile = input.model && QIDI_PROFILES[input.model]
  const objects = profile
    ? [
        ...baseObjects,
        profile.partFan,
        ...profile.auxFans,
        ...[profile.chamberFan, profile.chamberHeater, profile.box].filter(
          (name) => name !== undefined,
        ),
      ]
    : unboundObjects

  const auth = input.auth
  const headers = new Headers()
  if (auth && 'apiKey' in auth) headers.set('X-Api-Key', auth.apiKey)
  if (auth && 'bearerToken' in auth)
    headers.set('Authorization', `Bearer ${auth.bearerToken}`)

  async function read(
    url: URL,
    mediaType: string,
    cancel?: AbortSignal,
  ): Promise<Buffer> {
    const timeout = AbortSignal.timeout(input.timeoutMs ?? 3000)
    const signal = cancel ? AbortSignal.any([cancel, timeout]) : timeout
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await fetch(url, {
        headers,
        signal,
        redirect: 'error',
        credentials: 'omit',
      })
      reader = response.body?.getReader()
      if (response.status === 401 || response.status === 403)
        throw new QidiProtocolError('unauthorized')
      if (response.status === 404) throw new QidiProtocolError('unsupported')
      if (!response.ok) throw new QidiProtocolError('offline')
      if (
        !reader ||
        response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase() !== mediaType
      )
        throw new QidiProtocolError('invalid-response')

      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) return Buffer.concat(chunks, size)
        size += value.byteLength
        if (size > 2 * 1024 * 1024)
          throw new QidiProtocolError('invalid-response')
        chunks.push(value)
      }
    } catch (error) {
      if (error instanceof QidiProtocolError) throw error
      throw new QidiProtocolError(signal.aborted ? 'timeout' : 'offline')
    } finally {
      await reader?.cancel().catch(() => {})
      reader?.releaseLock()
    }
  }

  async function query(path: string, cancel?: AbortSignal) {
    const bytes = await read(new URL(path, origin), 'application/json', cancel)
    try {
      const envelope = record(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      )
      if ('error' in envelope) throw new QidiProtocolError('invalid-response')
      return record(envelope.result)
    } catch {
      throw new QidiProtocolError('invalid-response')
    }
  }

  return {
    // A targeted probe establishes protocol reachability. Model and firmware
    // identity come from local provisioning, not from a generic Moonraker reply.
    async discover(cancel?: AbortSignal) {
      const info = await query('/server/info', cancel)
      if (
        typeof info.moonraker_version !== 'string' ||
        typeof info.klippy_connected !== 'boolean' ||
        typeof info.klippy_state !== 'string'
      )
        throw new QidiProtocolError('invalid-response')
      return {
        moonrakerVersion: info.moonraker_version,
        klippyConnected: info.klippy_connected,
        klippyState: info.klippy_state,
      }
    },
    async readState(cancel?: AbortSignal) {
      const result = await query(
        `/printer/objects/query?${objects.map(encodeURIComponent).join('&')}`,
        cancel,
      )
      const status = record(result.status)
      const read = (name: string | undefined) =>
        name === undefined ? undefined : optionalRecord(status[name])
      const common = {
        webhooks: read('webhooks'),
        printStats: read('print_stats'),
        virtualSdcard: read('virtual_sdcard'),
        extruder: read('extruder'),
        heaterBed: read('heater_bed'),
      }
      if (!profile)
        return {
          ...common,
          fan: read(status.fan === undefined ? namedPartFan : 'fan'),
        }
      return {
        ...common,
        fan: read(profile.partFan),
        // One entry per cited object, in profile order.
        auxFans: profile.auxFans.map(read),
        chamberFan: read(profile.chamberFan),
        chamber: read(profile.chamberHeater),
        box: read(profile.box),
      }
    },
    async readHistory() {
      const result = await query('/server/history/list?limit=50&order=desc')
      if (!Array.isArray(result.jobs))
        throw new QidiProtocolError('invalid-response')
      return result.jobs.map(record)
    },
    async readSnapshot() {
      if (!snapshot) throw new QidiProtocolError('unsupported')
      const jpeg = await read(snapshot, 'image/jpeg')
      if (
        jpeg.length < 4 ||
        jpeg.readUInt16BE() !== 0xffd8 ||
        jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9
      )
        throw new QidiProtocolError('invalid-response')
      return jpeg
    },
    upload(file: { filePath: string; name: string; signal: AbortSignal }) {
      if (auth && 'bearerToken' in auth)
        throw new QidiProtocolError('unsupported')
      if (!/^[^/\\\x00-\x1f\x7f"]+\.gcode$/i.test(file.name))
        throw new TypeError('Expected a plain G-code filename')
      return uploadMoonrakerFile({
        ...file,
        origin: origin.origin,
        ...(auth?.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
      })
    },
  }
}
