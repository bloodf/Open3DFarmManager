import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AnycubicConfigurationTarget } from '../../../farm-protocol/src/configuration-target.ts'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import { createAnycubicLanClient } from '../anycubic/index.ts'
import { AnycubicBinding } from '../config/anycubic.ts'
import { readAgentRuntimeConfig } from '../config/runtime.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import type { RuntimeScope } from './runtime-commit.ts'
import type { CommitPlan } from './journal.ts'
import {
  readPrivateJson,
  writePrivateJsonAtomic,
  removePrivateFile,
} from './private-fs.ts'

const Credentials = z.strictObject({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(2048),
})
export function anycubicCredentialPath(directory: string, operationId: string) {
  return join(directory, 'credentials', `${operationId}.anycubic.json`)
}
export function discardStagedAnycubic(directory: string, operationId: string) {
  const path = anycubicCredentialPath(directory, operationId)
  removePrivateFile(path)
  removePrivateFile(path + '.password.json')
}
export function anycubicIdentity(
  target: Pick<AnycubicConfigurationTarget, 'modelId' | 'deviceId'>,
) {
  const digest = createHash('sha256')
    .update(
      'Open3DFarmManager/anycubic-lan/device\0' +
        JSON.stringify([target.modelId, target.deviceId]),
    )
    .digest('base64url')
  return { bridge_instance_id: 'anycubic-' + digest, device_id: digest }
}
export type AnycubicProbe = (input: {
  host: string
  port: number
  modelId: string
  deviceId: string
  credentialFile: string
  signal: AbortSignal
}) => Promise<boolean>
/** Subscribe only. No printer command or request is published. */
export const probeAnycubic: AnycubicProbe = async (input) => {
  if (input.signal.aborted) return false
  const credentials = Credentials.parse(
    readPrivateJsonFile(input.credentialFile, { maxBytes: 8192 }),
  )
  const controller = new AbortController()
  let connected = false
  const client = createAnycubicLanClient({
    host: input.host,
    port: input.port,
    serial: input.modelId + '/' + input.deviceId,
    credentials,
    signal: AbortSignal.any([input.signal, controller.signal]),
    limits: {
      maxFrameBytes: 65536,
      connectTimeoutMs: 5000,
      maxInflight: 16,
      reconnectDelayMs: 1000,
      maxReconnects: 0,
    },
    onReport() {},
    onConnection(state) {
      if (state === 'connected') {
        connected = true
        controller.abort()
      }
    },
  })
  try {
    await client.done
  } finally {
    controller.abort()
    await client.close()
  }
  return connected
}
export async function prepareAnycubic(
  directory: string,
  operationId: string,
  target: AnycubicConfigurationTarget,
  probe: AnycubicProbe = probeAnycubic,
) {
  const credentialFile = anycubicCredentialPath(directory, operationId)
  // Parse just the credential fields, never retain them in the journal target.
  const credentials = Credentials.safeParse({
    username: target.username,
    password: target.password,
  })
  if (!credentials.success) return false
  writePrivateJsonAtomic(credentialFile, credentials.data)
  let ok = false
  try {
    ok = await probe({
      host: target.host,
      port: target.port,
      modelId: target.modelId,
      deviceId: target.deviceId,
      credentialFile,
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    /* Sanitized failure. */
  }
  if (!ok) removePrivateFile(credentialFile)
  return ok
}
const LooseRuntime = z.looseObject({
  version: z.union([z.literal(1), z.literal(5)]),
  collection: z.looseObject({
    version: z.union([z.literal(1), z.literal(5)]),
    printers: z.array(z.unknown()),
    anycubic: z.strictObject({ printers: z.array(AnycubicBinding) }).optional(),
  }),
  assignments: z.array(
    z.looseObject({ assignment_id: z.string(), printer_key: z.string() }),
  ),
})
function runtime(scope: RuntimeScope) {
  const raw = readPrivateJson(scope.runtimeConfigPath)
  if (raw !== null) readAgentRuntimeConfig(scope.runtimeConfigPath, scope)
  if (raw === null && !scope.bootstrap)
    throw Error('Runtime configuration missing')
  if (
    raw === null &&
    Object.keys(scope.bootstrap ?? {}).some((k) =>
      ['version', 'collection', 'assignments', 'pause', 'camera'].includes(k),
    )
  )
    throw Error('Invalid zero-printer runtime template')
  return LooseRuntime.parse(
    raw ?? {
      ...scope.bootstrap,
      version: 5,
      collection: { version: 5, printers: [], allowedOrigins: [] },
      assignments: [],
    },
  )
}
export function existingAnycubicBinding(
  scope: RuntimeScope,
  target: AnycubicConfigurationTarget,
  identity: Pick<CommitPlan, 'assignment_id' | 'printer_key'>,
  credentialFile?: string,
) {
  const current = runtime(scope)
  const rows = current.collection.anycubic?.printers ?? []
  const printer = rows.find(
    (p) =>
      p.printerKey === identity.printer_key ||
      (p.modelId === target.modelId && p.deviceId === target.deviceId) ||
      (p.host === target.host && p.port === target.port),
  )
  if (!printer) {
    if (
      current.assignments.some(
        (a) =>
          a.assignment_id === identity.assignment_id ||
          a.printer_key === identity.printer_key,
      )
    )
      throw Error('Anycubic identity conflict')
    return false
  }
  if (
    printer.host !== target.host ||
    printer.port !== target.port ||
    printer.modelId !== target.modelId ||
    printer.deviceId !== target.deviceId ||
    printer.printerKey !== identity.printer_key ||
    !current.assignments.some(
      (a) =>
        a.assignment_id === identity.assignment_id &&
        a.printer_key === identity.printer_key,
    )
  )
    throw Error('Anycubic identity conflict')
  if (credentialFile) {
    const staged = Credentials.parse(
      readPrivateJsonFile(credentialFile, { maxBytes: 8192 }),
    )
    const password = readPrivateJsonFile(printer.passwordFile, {
      maxBytes: 4096,
    })
    if (staged.username !== printer.username || staged.password !== password)
      throw Error('Anycubic credential conflict')
  }
  return true
}
export function anycubicRuntimeContains(
  scope: RuntimeScope,
  target: AnycubicConfigurationTarget,
  plan: CommitPlan,
) {
  return existingAnycubicBinding(scope, target, plan)
}
export function commitAnycubic(
  scope: RuntimeScope,
  target: AnycubicConfigurationTarget,
  plan: CommitPlan,
) {
  if (existingAnycubicBinding(scope, target, plan, plan.credential_file)) return
  const credentials = Credentials.parse(
    readPrivateJsonFile(plan.credential_file, { maxBytes: 8192 }),
  )
  const current = runtime(scope)
  const passwordFile = plan.credential_file + '.password.json'
  writePrivateJsonAtomic(passwordFile, credentials.password)
  const next = {
    ...current,
    version: 5,
    collection: {
      ...current.collection,
      version: 5,
      anycubic: {
        printers: [
          ...(current.collection.anycubic?.printers ?? []),
          {
            printerKey: plan.printer_key,
            host: target.host,
            port: target.port,
            modelId: target.modelId,
            deviceId: target.deviceId,
            username: credentials.username,
            passwordFile,
          },
        ],
      },
    },
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
    writePrivateJsonAtomic(scope.runtimeConfigPath, next, (path) => {
      readAgentRuntimeConfig(path, scope)
    })
  } catch (error) {
    if (
      canonicalize(readPrivateJson(scope.runtimeConfigPath)) !==
      canonicalize(next)
    )
      removePrivateFile(passwordFile)
    throw error
  }
}
