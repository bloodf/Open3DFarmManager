import { z } from 'zod'
import { readAgentRuntimeConfig } from '../config/runtime.ts'
import type { KobraLinkRuntimeBinding } from '../kobralink/runtime.ts'
import type { BridgeRecord } from './bridge-custody.ts'
import type { CommitPlan, ObservedPrinter } from './journal.ts'
import {
  readPrivateJson,
  removePrivateFile,
  writePrivateJsonAtomic,
} from './private-fs.ts'

/**
 * Runtime assignment persistence through the accepted runtime schema. Every
 * candidate is published only after `readAgentRuntimeConfig` accepts it, so
 * the committed file is exactly what the Connector loads at startup.
 */
const LooseObject = z.record(z.string(), z.unknown())
const LooseRuntime = z.looseObject({
  version: z.union([z.literal(1), z.literal(2)]),
  collection: z.looseObject({
    version: z.union([z.literal(1), z.literal(2)]),
    kobralink: z
      .looseObject({
        allowedOrigins: z.array(z.string()),
        printers: z.array(LooseObject),
      })
      .optional(),
  }),
  assignments: z.array(z.unknown()),
})

export interface RuntimeScope {
  runtimeConfigPath: string
  agent_id: string
  farm_id: string
  /**
   * Explicit zero-printer provisioning mode. Only when the runtime file does
   * not exist yet, these local non-collection sections (telemetry, renewal,
   * signalling, rtc) seed the first committed runtime. The candidate is still
   * published only after the strict runtime reader accepts it, so an empty
   * runtime is never written or loaded.
   */
  bootstrap?: Readonly<Record<string, unknown>>
}

const BOOTSTRAP_FORBIDDEN = new Set([
  'version',
  'collection',
  'assignments',
  'pause',
  'camera',
])

function readRuntime(scope: RuntimeScope) {
  const raw = readPrivateJson(scope.runtimeConfigPath)
  if (raw === null) {
    if (!scope.bootstrap) throw new Error('Runtime configuration missing')
    if (
      Object.keys(scope.bootstrap).some((key) => BOOTSTRAP_FORBIDDEN.has(key))
    )
      throw new Error('Invalid zero-printer runtime template')
    return LooseRuntime.parse({
      ...scope.bootstrap,
      version: 2,
      collection: { version: 2, allowedOrigins: [], printers: [] },
      assignments: [],
    })
  }
  return LooseRuntime.parse(raw)
}

export function bindingFor(
  plan: CommitPlan,
  bridge: BridgeRecord,
  printer: ObservedPrinter,
): KobraLinkRuntimeBinding {
  return {
    backend: 'kobralink',
    version: 2,
    bridgeInstance: bridge.bridge_instance_id,
    origin: bridge.origin,
    deviceId: printer.device_id,
    id: printer.id,
    printerKey: plan.printer_key,
    revision: plan.committed_revision,
    credentialFile: plan.credential_file,
  }
}

/** Existing KobraLink bindings, for conflict checks before any write. */
export function existingKobraBindings(scope: RuntimeScope) {
  const runtime = readRuntime(scope)
  return {
    printerKeys: new Set(
      runtime.assignments.flatMap((a) =>
        typeof a === 'object' && a && 'printer_key' in a
          ? [String(a.printer_key)]
          : [],
      ),
    ),
    bindings: (runtime.collection.kobralink?.printers ?? []).map((p) => ({
      bridgeInstance: String(p.bridgeInstance),
      deviceId: String(p.deviceId),
      id: String(p.id),
    })),
  }
}

/** True only when the exact planned assignment is present (crash reconciliation). */
export function runtimeContains(
  scope: RuntimeScope,
  binding: KobraLinkRuntimeBinding,
  plan: CommitPlan,
): boolean {
  const runtime = readRuntime(scope)
  const assigned = runtime.assignments.some(
    (a) =>
      typeof a === 'object' &&
      a !== null &&
      'assignment_id' in a &&
      a.assignment_id === plan.assignment_id,
  )
  const bound = (runtime.collection.kobralink?.printers ?? []).some(
    (p) =>
      p.bridgeInstance === binding.bridgeInstance &&
      p.deviceId === binding.deviceId &&
      p.id === binding.id &&
      p.revision === binding.revision,
  )
  return assigned && bound
}

/**
 * Writes the per-binding credential (private custody), then atomically adds
 * the assignment, preserving every other assignment and printer.
 */
export function commitRuntimeAssignment(
  scope: RuntimeScope,
  plan: CommitPlan,
  bridge: BridgeRecord,
  printer: ObservedPrinter,
): void {
  const binding = bindingFor(plan, bridge, printer)
  writePrivateJsonAtomic(plan.credential_file, {
    version: 1,
    bridgeInstance: binding.bridgeInstance,
    origin: binding.origin,
    deviceId: binding.deviceId,
    id: binding.id,
    printerKey: binding.printerKey,
    revision: binding.revision,
    ...bridge.account,
  })
  const runtime = readRuntime(scope)
  const collection = runtime.collection
  const kobralink = collection.kobralink ?? {
    allowedOrigins: [],
    printers: [],
  }
  const next = {
    ...runtime,
    version: 2,
    collection: {
      ...collection,
      version: 2,
      kobralink: {
        ...kobralink,
        allowedOrigins: kobralink.allowedOrigins.includes(binding.origin)
          ? kobralink.allowedOrigins
          : [...kobralink.allowedOrigins, binding.origin],
        printers: [...kobralink.printers, binding],
      },
    },
    assignments: [
      ...runtime.assignments,
      {
        assignment_id: plan.assignment_id,
        farm_id: scope.farm_id,
        agent_id: scope.agent_id,
        printer_key: binding.printerKey,
        backend: 'kobralink',
        bridgeInstance: binding.bridgeInstance,
        origin: binding.origin,
        deviceId: binding.deviceId,
        id: binding.id,
        revision: binding.revision,
      },
    ],
  }
  writePrivateJsonAtomic(scope.runtimeConfigPath, next, (temporary) => {
    readAgentRuntimeConfig(temporary, {
      agent_id: scope.agent_id,
      farm_id: scope.farm_id,
    })
  })
}

/** Removes a credential file written for a commit that never landed. */
export function discardPlannedCredential(plan: CommitPlan): void {
  removePrivateFile(plan.credential_file)
}
