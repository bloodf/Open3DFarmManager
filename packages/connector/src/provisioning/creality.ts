import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import { CREALITY_NATIVE_PORT } from '../../../farm-protocol/src/configuration-target.ts'
import { decodeCrealityStatus } from '../creality/index.ts'
import {
  crealityBindingsPath,
  parseCrealityOnboardedConfig,
} from '../config/creality-onboarding.ts'
import { readPrivateJson, writePrivateJsonAtomic } from './private-fs.ts'
import type { RuntimeScope } from './runtime-commit.ts'
import type { CommitPlan } from './journal.ts'

export type CrealityProbe = (input: {
  host: string
  signal: AbortSignal
}) => Promise<boolean>
/** No requests or commands: accept only an unsolicited stock telemetry report. */
export const probeCreality: CrealityProbe = ({ host, signal }) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const socket = new WebSocket(`ws://${host}:${CREALITY_NATIVE_PORT}`, {
      maxPayload: 65536,
      handshakeTimeout: 5000,
      perMessageDeflate: false,
      followRedirects: false,
    })
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      socket.terminate()
      resolve(ok)
    }
    const abort = () => finish(false)
    signal.addEventListener('abort', abort, { once: true })
    socket.on('error', abort)
    socket.once('close', abort)
    socket.on('message', (data, binary) => {
      if (binary) return
      const report = decodeCrealityStatus(data.toString())
      if (report?.state !== undefined && report.progress !== undefined)
        finish(true)
    })
  })
export function crealityIdentity(host: string) {
  const digest = createHash('sha256')
    .update('Open3DFarmManager/creality-native/host\0' + host)
    .digest('base64url')
  return { bridge_instance_id: 'creality-' + digest, device_id: digest }
}
function store(scope: RuntimeScope) {
  return parseCrealityOnboardedConfig(
    readPrivateJson(crealityBindingsPath(scope.runtimeConfigPath)) ?? {
      version: 1,
      printers: [],
      assignments: [],
    },
    scope,
  )
}
export function existingCrealityBinding(
  scope: RuntimeScope,
  host: string,
  identity: Pick<CommitPlan, 'assignment_id' | 'printer_key'>,
) {
  const current = store(scope)
  const printer = current.printers.find(
    (p) => p.host === host || p.printerKey === identity.printer_key,
  )
  if (!printer) {
    if (
      current.assignments.some(
        (a) => a.assignment_id === identity.assignment_id,
      )
    )
      throw new Error('Creality identity conflict')
    return false
  }
  if (
    printer.host !== host ||
    printer.printerKey !== identity.printer_key ||
    !current.assignments.some(
      (a) =>
        a.assignment_id === identity.assignment_id &&
        a.printer_key === identity.printer_key,
    )
  )
    throw new Error('Creality identity conflict')
  return true
}
export function crealityRuntimeContains(
  scope: RuntimeScope,
  host: string,
  plan: CommitPlan,
) {
  return existingCrealityBinding(scope, host, plan)
}
export function commitCreality(
  scope: RuntimeScope,
  host: string,
  plan: CommitPlan,
) {
  if (existingCrealityBinding(scope, host, plan)) return
  const current = store(scope)
  const next = {
    version: 1,
    printers: [
      ...current.printers,
      { printerKey: plan.printer_key, host, port: CREALITY_NATIVE_PORT },
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
  parseCrealityOnboardedConfig(next, scope)
  writePrivateJsonAtomic(
    crealityBindingsPath(scope.runtimeConfigPath),
    next,
    (path) => {
      parseCrealityOnboardedConfig(readPrivateJson(path), scope)
    },
  )
}
