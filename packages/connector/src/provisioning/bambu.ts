import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { z } from 'zod'
import {
  BAMBU_LAN_MQTT_PORT,
  type BambuConfigurationTarget,
} from '../../../farm-protocol/src/configuration-target.ts'
import { createBambuTransport } from '../bambu/transport.ts'
import {
  BAMBU_BINDINGS_MAX_BYTES,
  EMPTY_BAMBU_BINDINGS,
  MAX_BAMBU_BINDINGS,
  bambuBindingsPath,
  parseBambuOnboardedConfig,
} from '../config/bambu.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import type { CommitPlan } from './journal.ts'
import type { RuntimeScope } from './runtime-commit.ts'
import {
  ensurePrivateDirectory,
  readPrivateJson,
  removePrivateFile,
  writePrivateJsonAtomic,
} from './private-fs.ts'

const PROBE_TIMEOUT_MS = 8000
const Staged = z.strictObject({ accessCode: z.string().min(1).max(256) })
const Trust = z.strictObject({
  host: z.string(),
  port: z.literal(BAMBU_LAN_MQTT_PORT),
  serial: z.string(),
  control: z.boolean(),
  pinSha256: z.string().regex(/^[a-f0-9]{64}$/),
})

export type BambuProbeResult = { ok: true; pinSha256: string } | { ok: false }
/**
 * Read-only reachability and credential check. It may open TLS and subscribe
 * to the printer report topic; it must never publish a request.
 */
export type BambuProbe = (input: {
  host: string
  port: number
  serial: string
  credentialFile: string
  signal: AbortSignal
}) => Promise<BambuProbeResult>

/** Stable identity from the serial only. Opaque: the serial is not recoverable. */
export function bambuIdentity(serial: string) {
  const digest = createHash('sha256')
    .update('Open3DFarmManager/bambu-lan/serial\0' + serial)
    .digest('base64url')
  return { bridge_instance_id: 'bambu-' + digest, device_id: 'sn-' + digest }
}
export function bambuCredentialPath(directory: string, operationId: string) {
  return join(directory, 'credentials', `${operationId}.bambu.json`)
}
export function bambuTrustPath(directory: string, operationId: string) {
  return join(directory, 'credentials', `${operationId}.bambu-trust.json`)
}
export function discardStagedBambu(directory: string, operationId: string) {
  removePrivateFile(bambuCredentialPath(directory, operationId))
  removePrivateFile(bambuTrustPath(directory, operationId))
}

function leafPin(host: string, port: number, signal: AbortSignal) {
  return new Promise<string | null>((resolve) => {
    // Trust on first use: the observed leaf is pinned and required afterwards.
    const socket = tlsConnect({
      host,
      port,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: false,
    })
    const finish = (pin: string | null) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.destroy()
      resolve(pin)
    }
    const abort = () => finish(null)
    const timer = setTimeout(abort, PROBE_TIMEOUT_MS)
    signal.addEventListener('abort', abort, { once: true })
    socket.once('error', () => finish(null))
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate().raw
      finish(raw ? createHash('sha256').update(raw).digest('hex') : null)
    })
  })
}

/** Default probe: pin the TLS leaf, then prove the access code by subscribing. */
export const probeBambuLan: BambuProbe = async (input) => {
  const pinSha256 = await leafPin(input.host, input.port, input.signal)
  if (!pinSha256) return { ok: false }
  let accessCode: string
  try {
    accessCode = Staged.parse(
      readPrivateJsonFile(input.credentialFile, { maxBytes: 4096 }),
    ).accessCode
  } catch {
    return { ok: false }
  }
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let connected = false
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const transport = createBambuTransport({
      host: input.host,
      port: input.port,
      serial: input.serial,
      credentials: { username: 'bblp', password: accessCode },
      pinSha256,
      limits: {
        maxFrameBytes: 131072,
        connectTimeoutMs: PROBE_TIMEOUT_MS,
        maxInflight: 16,
        reconnectDelayMs: 1000,
        maxReconnects: 0,
      },
      signal,
      onReport() {},
      onConnection(state) {
        if (state === 'connected') connected = true
        controller.abort()
      },
    })
    await transport.done
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return connected ? { ok: true, pinSha256 } : { ok: false }
}

/** The submitted access code lives only in private Connector credential files. */
export async function prepareBambu(
  directory: string,
  operationId: string,
  target: BambuConfigurationTarget,
  probe: BambuProbe = probeBambuLan,
): Promise<{ ok: true } | { ok: false; code: 'not-available' }> {
  const unavailable = { ok: false, code: 'not-available' } as const
  if (!target.access_code) return unavailable
  ensurePrivateDirectory(join(directory, 'credentials'))
  const credentialFile = bambuCredentialPath(directory, operationId)
  writePrivateJsonAtomic(credentialFile, { accessCode: target.access_code })
  let result: BambuProbeResult
  try {
    result = await probe({
      host: target.ipv4,
      port: BAMBU_LAN_MQTT_PORT,
      serial: target.serial,
      credentialFile,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 3),
    })
  } catch {
    result = { ok: false }
  }
  const trust = result.ok
    ? Trust.safeParse({
        host: target.ipv4,
        port: BAMBU_LAN_MQTT_PORT,
        serial: target.serial,
        control: target.control,
        pinSha256: result.pinSha256.toLowerCase(),
      })
    : null
  if (!trust?.success) {
    discardStagedBambu(directory, operationId)
    return unavailable
  }
  writePrivateJsonAtomic(bambuTrustPath(directory, operationId), trust.data)
  return { ok: true }
}

function store(scope: RuntimeScope) {
  const path = bambuBindingsPath(scope.runtimeConfigPath)
  if (readPrivateJson(path) === null) return EMPTY_BAMBU_BINDINGS
  return parseBambuOnboardedConfig(
    readPrivateJsonFile(path, { maxBytes: BAMBU_BINDINGS_MAX_BYTES }),
    scope,
  )
}
const staged = (path: string) =>
  Staged.parse(readPrivateJsonFile(path, { maxBytes: 4096 }))

/** Repeated onboarding may reuse our exact canonical binding, never a foreign row. */
export function existingBambuCredential(
  scope: RuntimeScope,
  target: Pick<BambuConfigurationTarget, 'ipv4' | 'serial' | 'control'>,
  identity: { assignment_id: string; printer_key: string },
  stagedPath: string,
): string | null {
  const current = store(scope)
  const printer = current.printers.find(
    (p) => p.serial === target.serial || p.host === target.ipv4,
  )
  if (!printer) return null
  if (
    printer.serial !== target.serial ||
    printer.host !== target.ipv4 ||
    printer.printerKey !== identity.printer_key ||
    !current.assignments.some(
      (a) =>
        a.assignment_id === identity.assignment_id &&
        a.printer_key === identity.printer_key,
    )
  )
    throw new Error('Bambu identity conflict')
  if (
    printer.control !== target.control ||
    staged(printer.credentialFile).accessCode !== staged(stagedPath).accessCode
  )
    throw new Error('Bambu credential conflict')
  return printer.credentialFile
}

export function bambuRuntimeContains(
  scope: RuntimeScope,
  serial: string,
  plan: CommitPlan,
): boolean {
  const current = store(scope)
  return (
    current.printers.some(
      (p) =>
        p.serial === serial &&
        p.printerKey === plan.printer_key &&
        p.credentialFile === plan.credential_file,
    ) &&
    current.assignments.some(
      (a) =>
        a.assignment_id === plan.assignment_id &&
        a.printer_key === plan.printer_key,
    )
  )
}

/** Atomically adds one binding; published only after the strict reader accepts it. */
export function commitBambu(
  scope: RuntimeScope,
  serial: string,
  plan: CommitPlan,
  trustPath: string,
): void {
  if (bambuRuntimeContains(scope, serial, plan)) return
  const current = store(scope)
  const trust = Trust.parse(readPrivateJsonFile(trustPath, { maxBytes: 4096 }))
  if (trust.serial !== serial) throw new Error('Bambu trust mismatch')
  if (
    current.printers.length >= MAX_BAMBU_BINDINGS ||
    current.printers.some(
      (p) =>
        p.serial === serial ||
        p.host === trust.host ||
        p.printerKey === plan.printer_key,
    ) ||
    current.assignments.some(
      (a) =>
        a.assignment_id === plan.assignment_id ||
        a.printer_key === plan.printer_key,
    )
  )
    throw new Error('Bambu identity conflict')
  staged(plan.credential_file)
  const next = {
    version: 1,
    printers: [
      ...current.printers,
      {
        printerKey: plan.printer_key,
        serial,
        host: trust.host,
        port: trust.port,
        control: trust.control,
        credentialFile: plan.credential_file,
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
  writePrivateJsonAtomic(
    bambuBindingsPath(scope.runtimeConfigPath),
    next,
    (path) => {
      parseBambuOnboardedConfig(
        readPrivateJsonFile(path, { maxBytes: BAMBU_BINDINGS_MAX_BYTES }),
        scope,
      )
    },
  )
}
