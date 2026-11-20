import type { Logger } from '@open3dfarmmanager/shared'
import {
  isBambuCloudEnabled,
  resolveBambuCloudEndpoint,
} from '../../../../../packages/connector/src/bambu/cloud.ts'
import type { BambuCloudFailure } from './account.ts'

const MAX_BODY = 65536
const MAX_DEVICES = 256
const SERIAL = /^[0-9A-Z]{10,20}$/
const LABEL = /^[\x20-\x7E]{1,128}$/
const TOKEN = /^[\x21-\x7E]{16,4096}$/

export type BambuCloudPrinterDiscovery = {
  serial: string
  name: string
  model: string
  nozzle: number
}

export type BambuCloudImportPrintersOk = {
  ok: true
  printers: BambuCloudPrinterDiscovery[]
  skippedMalformed: number
}

export type BambuCloudImportPrintersResult =
  BambuCloudImportPrintersOk | { ok: false; reason: BambuCloudFailure }

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  return value as Record<string, unknown>
}

function endpointUrl(endpoint: string, policy: unknown): URL | null {
  try {
    const url = resolveBambuCloudEndpoint(endpoint, policy)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      return null
    return url
  } catch {
    return null
  }
}

async function readJson(response: Response): Promise<unknown | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY) return null
  const text = await response.text()
  if (text.length > MAX_BODY) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function parseDevice(value: unknown): BambuCloudPrinterDiscovery | null {
  const body = record(value)
  if (!body) return null
  const serial = body.dev_id
  const name = body.name
  const model = body.dev_model_name
  const nozzle = body.nozzle_diameter
  if (typeof serial !== 'string' || !SERIAL.test(serial)) return null
  if (typeof name !== 'string' || !LABEL.test(name)) return null
  if (typeof model !== 'string' || !LABEL.test(model)) return null
  if (
    typeof nozzle !== 'number' ||
    !Number.isFinite(nozzle) ||
    nozzle <= 0 ||
    nozzle > 10
  )
    return null
  return { serial, name, model, nozzle }
}

/**
 * Turns a cloud `devices` array into discovery rows for the Bambu setup form.
 * Duplicates (same serial, including against `knownSerials`) are dropped.
 * Malformed entries are skipped and counted.
 */
export function normalizeBambuCloudDevices(
  devices: unknown,
  knownSerials: Iterable<string> = [],
): BambuCloudImportPrintersOk {
  const seen = new Set<string>()
  for (const serial of knownSerials) {
    if (typeof serial === 'string' && SERIAL.test(serial)) seen.add(serial)
  }
  if (!Array.isArray(devices))
    return { ok: true, printers: [], skippedMalformed: 0 }
  const printers: BambuCloudPrinterDiscovery[] = []
  let skippedMalformed = 0
  const limit = Math.min(devices.length, MAX_DEVICES)
  for (let index = 0; index < limit; index += 1) {
    const parsed = parseDevice(devices[index])
    if (!parsed) {
      skippedMalformed += 1
      continue
    }
    if (seen.has(parsed.serial)) continue
    seen.add(parsed.serial)
    printers.push(parsed)
  }
  if (devices.length > MAX_DEVICES)
    skippedMalformed += devices.length - MAX_DEVICES
  return { ok: true, printers, skippedMalformed }
}

export async function fetchBambuCloudBindDevices(input: {
  endpoint: string
  accessToken: string
  policy: unknown
  fetchImpl?: typeof fetch | undefined
}): Promise<
  | { ok: true; devices: unknown }
  | { ok: false; reason: Extract<BambuCloudFailure, `cloud-${string}`> }
> {
  if (!isBambuCloudEnabled(input.policy))
    return { ok: false, reason: 'cloud-disabled' }
  if (!TOKEN.test(input.accessToken))
    return { ok: false, reason: 'cloud-rejected' }
  const base = endpointUrl(input.endpoint, input.policy)
  if (!base) return { ok: false, reason: 'cloud-rejected' }
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(
      new URL('/v1/iot-service/api/user/bind', base),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${input.accessToken}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      },
    )
    const json = await readJson(response)
    if (json === null) return { ok: false, reason: 'cloud-rejected' }
    if (response.status === 401 || response.status === 403)
      return { ok: false, reason: 'cloud-unauthorized' }
    if (response.status !== 200) return { ok: false, reason: 'cloud-rejected' }
    const body = record(json)
    if (!body || !('devices' in body))
      return { ok: false, reason: 'cloud-rejected' }
    return { ok: true, devices: body.devices }
  } catch {
    return { ok: false, reason: 'cloud-rejected' }
  }
}

export async function listBambuCloudAccountPrinters(input: {
  endpoint: string
  accessToken: string
  policy: unknown
  knownSerials?: Iterable<string> | undefined
  fetchImpl?: typeof fetch | undefined
  logger?: Logger | undefined
  farmId?: string | undefined
}): Promise<BambuCloudImportPrintersResult> {
  const listed = await fetchBambuCloudBindDevices({
    endpoint: input.endpoint,
    accessToken: input.accessToken,
    policy: input.policy,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  })
  if (!listed.ok) {
    if (input.logger && input.farmId) {
      input.logger.info('bambu cloud printers rejected', {
        farmId: input.farmId,
        outcome:
          listed.reason === 'cloud-disabled'
            ? 'disabled'
            : listed.reason === 'cloud-unauthorized'
              ? 'unauthorized'
              : 'rejected',
      })
    }
    return listed
  }
  const normalized = normalizeBambuCloudDevices(
    listed.devices,
    input.knownSerials ?? [],
  )
  if (input.logger && input.farmId) {
    input.logger.info('bambu cloud printers listed', {
      farmId: input.farmId,
      outcome: 'listed',
      printerCount: normalized.printers.length,
      skippedMalformed: normalized.skippedMalformed,
    })
  }
  return normalized
}
