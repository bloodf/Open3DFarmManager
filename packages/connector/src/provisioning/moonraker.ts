import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { MoonrakerConfigurationTarget } from '../../../farm-protocol/src/configuration-target.ts'
import { discoverMoonraker } from '../moonraker/discovery.ts'
import { MoonrakerClientError } from '../moonraker/client.ts'
import { readAgentRuntimeConfig } from '../config/runtime.ts'
import type { CommitPlan } from './journal.ts'
import type { RuntimeScope } from './runtime-commit.ts'
import {
  ensurePrivateDirectory,
  readPrivateJson,
  writePrivateJsonAtomic,
} from './private-fs.ts'

const limits = {
  maxMessageBytes: 256 * 1024,
  connectTimeoutMs: 5000,
  requestTimeoutMs: 5000,
  staleAfterMs: 30000,
  reconnectMinMs: 1000,
  reconnectMaxMs: 30000,
}
const Staged = z.strictObject({
  origin: z.string(),
  apiKey: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
})
const Runtime = z.looseObject({
  version: z.union([z.literal(1), z.literal(2)]),
  collection: z.looseObject({
    version: z.union([z.literal(1), z.literal(2)]),
    allowedOrigins: z.array(z.string()),
    printers: z.array(
      z.strictObject({
        printerKey: z.string(),
        origin: z.string(),
        apiKeyFile: z.string().optional(),
      }),
    ),
  }),
  assignments: z.array(z.record(z.string(), z.unknown())),
})

export function moonrakerIdentity(origin: string) {
  const digest = createHash('sha256')
    .update(new URL(origin).origin)
    .digest('base64url')
  const deviceId = /^[A-Za-z0-9]/.test(digest) ? digest : `m${digest}`
  return { bridge_instance_id: 'moonraker-' + digest, device_id: deviceId }
}
export function moonrakerCredentialPath(
  directory: string,
  operationId: string,
) {
  return join(directory, 'credentials', `${operationId}.moonraker.json`)
}

/** The submitted key lives only in private Connector credential configuration. */
export async function prepareMoonraker(
  directory: string,
  operationId: string,
  target: MoonrakerConfigurationTarget,
  discover: typeof discoverMoonraker = discoverMoonraker,
) {
  const origin = new URL(target.origin).origin
  ensurePrivateDirectory(join(directory, 'credentials'))
  const path = moonrakerCredentialPath(directory, operationId)
  writePrivateJsonAtomic(path, {
    origin,
    ...(target.api_key ? { apiKey: target.api_key } : {}),
    ...(target.username
      ? { username: target.username, password: target.password }
      : {}),
  })
  try {
    await discover({
      origin,
      ...(target.api_key || target.username ? { apiKeyFile: path } : {}),
      limits,
      signal: new AbortController().signal,
      client: {
        name: 'Open3DFarmManager',
        version: '1',
        url: 'https://open3dfarmmanager.local',
      },
    })
    return { ok: true } as const
  } catch (error) {
    const code =
      error instanceof MoonrakerClientError ? error.reason : 'offline'
    return {
      ok: false,
      code:
        code === 'not-ready'
          ? 'moonraker-not-ready'
          : code === 'invalid-response'
            ? 'moonraker-invalid-response'
            : 'moonraker-unavailable',
    } as const
  }
}
function runtime(scope: RuntimeScope) {
  const raw = readPrivateJson(scope.runtimeConfigPath)
  if (raw !== null) return Runtime.parse(raw)
  if (!scope.bootstrap) throw new Error('Runtime configuration missing')
  return Runtime.parse({
    ...scope.bootstrap,
    version: 1,
    collection: { version: 1, allowedOrigins: [], printers: [] },
    assignments: [],
  })
}
/** Repeated onboarding may reuse our exact canonical binding, never a manual row. */
export function existingMoonrakerCredential(
  scope: RuntimeScope,
  origin: string,
  identity: { assignment_id: string; printer_key: string },
  stagedPath: string,
): string | null {
  const current = runtime(scope)
  const printer = current.collection.printers.find((p) => p.origin === origin)
  if (!printer) return null
  const assignment = current.assignments.find(
    (a) =>
      a.assignment_id === identity.assignment_id &&
      a.printer_key === identity.printer_key &&
      a.moonraker_origin === origin &&
      a.agent_id === scope.agent_id &&
      a.farm_id === scope.farm_id,
  )
  if (!assignment || printer.printerKey !== identity.printer_key)
    throw new Error('Moonraker identity conflict')
  const staged = Staged.parse(readPrivateJson(stagedPath))
  const previous = printer.apiKeyFile
    ? Staged.parse(readPrivateJson(printer.apiKeyFile))
    : { origin }
  if (
    previous.origin !== origin ||
    previous.apiKey !== staged.apiKey ||
    previous.username !== staged.username ||
    previous.password !== staged.password
  )
    throw new Error('Moonraker credential conflict')
  return printer.apiKeyFile ?? stagedPath
}
export function moonrakerRuntimeContains(
  scope: RuntimeScope,
  origin: string,
  plan: CommitPlan,
) {
  const current = runtime(scope)
  return (
    current.collection.printers.some(
      (p) =>
        p.origin === origin &&
        p.printerKey === plan.printer_key &&
        (!p.apiKeyFile || p.apiKeyFile === plan.credential_file),
    ) &&
    current.assignments.some(
      (a) =>
        a.assignment_id === plan.assignment_id &&
        a.printer_key === plan.printer_key &&
        a.moonraker_origin === origin,
    )
  )
}
export function commitMoonraker(
  scope: RuntimeScope,
  origin: string,
  plan: CommitPlan,
) {
  const current = runtime(scope)
  if (moonrakerRuntimeContains(scope, origin, plan)) return
  if (
    current.collection.printers.some(
      (p) => p.origin === origin || p.printerKey === plan.printer_key,
    ) ||
    current.assignments.some(
      (a) =>
        a.assignment_id === plan.assignment_id ||
        a.printer_key === plan.printer_key,
    )
  )
    throw new Error('Moonraker identity conflict')
  const credential = Staged.parse(readPrivateJson(plan.credential_file))
  if (credential.origin !== origin)
    throw new Error('Moonraker credential origin mismatch')
  const next = {
    ...current,
    collection: {
      ...current.collection,
      allowedOrigins: [
        ...new Set([...current.collection.allowedOrigins, origin]),
      ],
      printers: [
        ...current.collection.printers,
        {
          origin,
          printerKey: plan.printer_key,
          ...(credential.apiKey || credential.username
            ? { apiKeyFile: plan.credential_file }
            : {}),
        },
      ],
    },
    assignments: [
      ...current.assignments,
      {
        assignment_id: plan.assignment_id,
        farm_id: scope.farm_id,
        agent_id: scope.agent_id,
        printer_key: plan.printer_key,
        moonraker_origin: origin,
      },
    ],
  }
  writePrivateJsonAtomic(scope.runtimeConfigPath, next, (path) => {
    readAgentRuntimeConfig(path, scope)
  })
}
