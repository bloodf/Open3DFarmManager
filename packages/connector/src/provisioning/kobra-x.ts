import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { KobraXNativeConfigurationTarget } from '../../../farm-protocol/src/configuration-target.ts'
import type { ConfigurationErrorCode } from '../../../farm-protocol/src/configuration-frames.ts'
import { configurationOpaqueId } from '../../../farm-protocol/src/configuration-common.ts'
import { captureAnycubicPeerPin } from '../anycubic/tls-trust.ts'
import {
  EMPTY_KOBRA_X_BINDINGS,
  KOBRA_X_BINDINGS_MAX_BYTES,
  MAX_KOBRA_X_BINDINGS,
  kobraXBindingsPath,
  parseKobraXOnboardedConfig,
} from '../config/kobra-x.ts'
import {
  certErrorCode,
  discardStagedKobraCert,
  kobraClientCertPath,
  kobraCredentialsDirectory,
  readKobraClientCertMaterial,
  stageKobraClientCert,
  stagedKobraCertPath,
  writeKobraClientCertFile,
} from '../config/kobra-x-cert.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import { isLocalAddress } from '../kobra-x/discovery.ts'
import { connectKobraX } from '../kobra-x/index.ts'
import type { CommitPlan } from './journal.ts'
import {
  ensurePrivateDirectory,
  readPrivateJson,
  removePrivateFile,
  writePrivateJsonAtomic,
} from './private-fs.ts'
import type { RuntimeScope } from './runtime-commit.ts'

const PROBE_TIMEOUT_MS = 12_000
const FIRMWARE_WAIT_MS = 1_500
const OBSERVED_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/
const FIRMWARE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/

/** Facts the Connector proved by reaching the printer. Never credentials. */
const Trust = z.strictObject({
  host: z.ipv4(),
  modelId: z.string().regex(/^[\w-]{1,128}$/),
  deviceId: z.string().regex(/^[\w-]{1,128}$/),
  pinSha256: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().regex(OBSERVED_TEXT).nullable(),
  firmware: z.string().regex(FIRMWARE).nullable(),
})
export type KobraXTrust = z.infer<typeof Trust>

export type KobraXProbeResult =
  | {
      ok: true
      modelId: string
      deviceId: string
      model: string | null
      firmware: string | null
      pinSha256: string
    }
  | { ok: false; code: ConfigurationErrorCode }

/**
 * Connection confirmation. Capture the peer key before opening the MQTT
 * session, then reconnect with that pin and confirm identity over mutual TLS.
 * The adapter publishes only read queries. Tests use the optional loopback
 * endpoint overrides.
 */
export interface KobraXProbeInput {
  host: string
  certFile: string
  signal: AbortSignal
  address?: string
  httpPort?: number
  mqttPort?: number
}
export type KobraXProbe = (
  input: KobraXProbeInput,
) => Promise<KobraXProbeResult>

/** Stable identity from the proven model and device id. Opaque by design. */
export function kobraXIdentity(modelId: string, deviceId: string) {
  const digest = createHash('sha256')
    .update(
      'Open3DFarmManager/kobra-x-native/device\0' +
        JSON.stringify([modelId, deviceId]),
    )
    .digest('base64url')
  return { bridge_instance_id: 'kobra-x-' + digest, device_id: 'kx-' + digest }
}

export function kobraXTrustPath(directory: string, operationId: string) {
  return join(
    kobraCredentialsDirectory(directory),
    `${operationId}.kobra-x-trust.json`,
  )
}
export function discardStagedKobraX(directory: string, operationId: string) {
  discardStagedKobraCert(directory, operationId)
  removePrivateFile(kobraXTrustPath(directory, operationId))
}

function failureCode(error: unknown): ConfigurationErrorCode {
  const message = error instanceof Error ? error.message : ''
  if (/client certificate or key is invalid/i.test(message))
    return 'client-cert-unreadable'
  if (/rejected client certificate|closed TLS before MQTT/i.test(message))
    return 'client-cert-wrong-subject'
  if (
    /LAN identity|credential recovery|credentials refused/i.test(message) ||
    /requires local IPv4/i.test(message)
  )
    return 'not-available'
  return 'bridge-unavailable'
}

async function observedFirmware(
  adapter: Awaited<ReturnType<typeof connectKobraX>>,
  signal: AbortSignal,
): Promise<string | null> {
  const deadline = Date.now() + FIRMWARE_WAIT_MS
  while (Date.now() < deadline && !signal.aborted) {
    const version = adapter.snapshot().firmware?.current
    if (version) return FIRMWARE.test(version) ? version : null
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

export const probeKobraXLan: KobraXProbe = async (input) => {
  const loaded = readKobraClientCertMaterial(input.certFile)
  if (!loaded.ok) return { ok: false, code: certErrorCode(loaded.reason) }
  if (input.signal.aborted) return { ok: false, code: 'bridge-unavailable' }
  const address = input.address ?? input.host
  if (!isLocalAddress(address)) return { ok: false, code: 'not-available' }
  const mqttPort = input.mqttPort ?? 9883
  const clientIdentity = {
    cert: loaded.cert.certificatePem,
    key: loaded.cert.keyPem,
  }
  let adapter: Awaited<ReturnType<typeof connectKobraX>> | undefined
  try {
    const pinSha256 = await captureAnycubicPeerPin(
      { host: address, port: mqttPort, ...clientIdentity },
      input.signal,
    )
    input.signal.throwIfAborted()
    adapter = await connectKobraX({
      address,
      printerKey: 'probe',
      clientIdentity,
      pinSha256,
      ...(input.httpPort ? { httpPort: input.httpPort } : {}),
      mqttPort,
      // A confirmation that retries would outlive its own timeout.
      reconnectMs: PROBE_TIMEOUT_MS,
      onError() {},
    })
    const { deviceId, modelId, name } = adapter.identity
    const firmware = await observedFirmware(adapter, input.signal)
    input.signal.throwIfAborted()
    return {
      ok: true,
      modelId,
      deviceId,
      model: OBSERVED_TEXT.test(name) ? name : null,
      firmware,
      pinSha256,
    }
  } catch (error) {
    return { ok: false, code: failureCode(error) }
  } finally {
    await adapter?.close().catch(() => undefined)
  }
}

export type KobraXPrepared =
  | {
      ok: true
      trust: KobraXTrust
      identity: ReturnType<typeof kobraXIdentity>
    }
  | { ok: false; code: ConfigurationErrorCode }

/**
 * Stages the operator's client certificate in private custody, confirms the
 * printer through a real login, and records what was proven. Every failure
 * discards the staged files: nothing is committed without a confirmation.
 */
export async function prepareKobraX(
  directory: string,
  operationId: string,
  target: KobraXNativeConfigurationTarget,
  probe: KobraXProbe = probeKobraXLan,
  now = Date.now(),
): Promise<KobraXPrepared> {
  ensurePrivateDirectory(directory)
  ensurePrivateDirectory(kobraCredentialsDirectory(directory))
  const certFile = stagedKobraCertPath(directory, operationId)
  if (target.client_certificate) {
    const staged = await stageKobraClientCert(
      directory,
      operationId,
      target.client_certificate,
      now,
    )
    if (!staged.ok) return { ok: false, code: staged.code }
  } else {
    // No new import: reuse the identity the operator already imported here.
    const previous = readKobraClientCertMaterial(
      kobraClientCertPath(directory),
      now,
    )
    if (!previous.ok) return { ok: false, code: certErrorCode(previous.reason) }
    writeKobraClientCertFile(certFile, previous.cert)
  }
  let result: KobraXProbeResult
  try {
    result = await probe({
      host: target.endpoint.ipv4,
      certFile,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
    })
  } catch {
    result = { ok: false, code: 'bridge-unavailable' }
  }
  const trust = result.ok
    ? Trust.safeParse({
        host: target.endpoint.ipv4,
        modelId: result.modelId,
        deviceId: result.deviceId,
        pinSha256: result.pinSha256.toLowerCase(),
        model: result.model,
        firmware: result.firmware,
      })
    : null
  if (!result.ok || !trust?.success) {
    discardStagedKobraX(directory, operationId)
    return { ok: false, code: result.ok ? 'not-available' : result.code }
  }
  const identity = kobraXIdentity(trust.data.modelId, trust.data.deviceId)
  if (!configurationOpaqueId.safeParse(identity.device_id).success) {
    discardStagedKobraX(directory, operationId)
    return { ok: false, code: 'not-available' }
  }
  writePrivateJsonAtomic(kobraXTrustPath(directory, operationId), trust.data)
  return { ok: true, trust: trust.data, identity }
}

export function readKobraXTrust(path: string): KobraXTrust {
  return Trust.parse(readPrivateJsonFile(path, { maxBytes: 4096 }))
}

/** Raw ids of native bindings and KobraLink rows, for cross-backend conflicts. */
export function kobraXDeviceClaims(scope: RuntimeScope) {
  const native = store(scope)
  const raw = readPrivateJson(scope.runtimeConfigPath)
  const collection =
    raw && typeof raw === 'object' && 'collection' in raw
      ? (raw as { collection?: { kobralink?: { printers?: unknown } } })
          .collection
      : undefined
  const rows = Array.isArray(collection?.kobralink?.printers)
    ? (collection.kobralink.printers as unknown[])
    : []
  return {
    native,
    kobraLinkDeviceIds: new Set(
      rows.flatMap((row) =>
        typeof row === 'object' &&
        row !== null &&
        'deviceId' in row &&
        typeof row.deviceId === 'string'
          ? [row.deviceId]
          : [],
      ),
    ),
  }
}

function store(scope: RuntimeScope) {
  const path = kobraXBindingsPath(scope.runtimeConfigPath)
  if (readPrivateJson(path) === null) return EMPTY_KOBRA_X_BINDINGS
  return parseKobraXOnboardedConfig(
    readPrivateJsonFile(path, { maxBytes: KOBRA_X_BINDINGS_MAX_BYTES }),
    scope,
  )
}

/**
 * Any existing claim on this printer, native or KobraLink, is a conflict: a
 * second path would command or report one physical printer twice, and a
 * foreign or manual mapping is never taken over.
 */
export function assertKobraXUnclaimed(
  scope: RuntimeScope,
  trust: Pick<KobraXTrust, 'host' | 'modelId' | 'deviceId'>,
  identity: Pick<CommitPlan, 'assignment_id' | 'printer_key'>,
): void {
  const { native, kobraLinkDeviceIds } = kobraXDeviceClaims(scope)
  if (
    kobraLinkDeviceIds.has(trust.deviceId) ||
    native.printers.some(
      (p) =>
        p.host === trust.host ||
        (p.modelId === trust.modelId && p.deviceId === trust.deviceId) ||
        p.printerKey === identity.printer_key,
    ) ||
    native.assignments.some(
      (a) =>
        a.assignment_id === identity.assignment_id ||
        a.printer_key === identity.printer_key,
    )
  )
    throw new Error('Kobra X identity conflict')
}

export function kobraXRuntimeContains(
  scope: RuntimeScope,
  plan: CommitPlan,
): boolean {
  const current = store(scope)
  return (
    current.printers.some(
      (p) =>
        p.printerKey === plan.printer_key &&
        p.clientCertFile === plan.credential_file,
    ) &&
    current.assignments.some(
      (a) =>
        a.assignment_id === plan.assignment_id &&
        a.printer_key === plan.printer_key,
    )
  )
}

/**
 * Atomically adds one binding after the strict reader accepts the candidate.
 * The staged certificate stays until the commit is durable, so an interrupted
 * commit can be retried without asking the operator to import it again.
 */
export function commitKobraX(
  scope: RuntimeScope,
  directory: string,
  operationId: string,
  plan: CommitPlan,
  trustPath: string,
): void {
  if (kobraXRuntimeContains(scope, plan)) return
  const trust = readKobraXTrust(trustPath)
  assertKobraXUnclaimed(scope, trust, plan)
  const current = store(scope)
  if (current.printers.length >= MAX_KOBRA_X_BINDINGS)
    throw new Error('Kobra X capacity exceeded')
  const staged = readKobraClientCertMaterial(
    stagedKobraCertPath(directory, operationId),
  )
  if (!staged.ok) throw new Error('Staged client certificate invalid')
  writeKobraClientCertFile(plan.credential_file, staged.cert)
  const next = {
    version: 1,
    printers: [
      ...current.printers,
      {
        printerKey: plan.printer_key,
        host: trust.host,
        modelId: trust.modelId,
        deviceId: trust.deviceId,
        clientCertFile: plan.credential_file,
        pinSha256: trust.pinSha256,
      },
    ],
    assignments: [
      ...current.assignments,
      {
        assignment_id: plan.assignment_id,
        farm_id: scope.farm_id,
        agent_id: scope.agent_id,
        printer_key: plan.printer_key,
      },
    ],
  }
  try {
    writePrivateJsonAtomic(
      kobraXBindingsPath(scope.runtimeConfigPath),
      next,
      (path) => {
        parseKobraXOnboardedConfig(
          readPrivateJsonFile(path, { maxBytes: KOBRA_X_BINDINGS_MAX_BYTES }),
          scope,
        )
      },
    )
  } catch (error) {
    if (!kobraXRuntimeContains(scope, plan))
      removePrivateFile(plan.credential_file)
    throw error
  }
  // Remembered so the next printer can reuse the operator's own import.
  writeKobraClientCertFile(kobraClientCertPath(directory), staged.cert)
}
