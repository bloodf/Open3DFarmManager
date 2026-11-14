import { dirname, join } from 'node:path'
import { z } from 'zod'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import { parseBambuBinding, type BambuBinding } from '../bambu/configuration.ts'
import { readBambuCredentials } from '../bambu/credentials.ts'

/**
 * Private Bambu bindings written by signed onboarding. They live beside the
 * accepted runtime file because the strict runtime reader has no Bambu
 * assignment mapping; the runtime file itself is never touched. Each row is
 * the exact `parseBambuBinding` shape plus the local assignment that
 * `provisionBambuPrinter` accepts. The access code is never stored here: only
 * the path of its private credential file.
 */
export const BAMBU_BINDINGS_FILE = 'bambu-bindings.json'
export const BAMBU_BINDINGS_MAX_BYTES = 64 * 1024
export const MAX_BAMBU_BINDINGS = 16

export function bambuBindingsPath(runtimeConfigPath: string): string {
  return join(dirname(runtimeConfigPath), BAMBU_BINDINGS_FILE)
}

const Assignment = z.strictObject({
  assignment_id: BrowserDeviceUuid,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  printer_key: z.string().min(1).max(128),
})
export type BambuOnboardedAssignment = z.infer<typeof Assignment>
const Store = z.strictObject({
  version: z.literal(1),
  printers: z.array(z.unknown()).max(MAX_BAMBU_BINDINGS),
  assignments: z.array(Assignment).max(MAX_BAMBU_BINDINGS),
})

export interface BambuOnboardedConfig {
  version: 1
  printers: readonly BambuBinding[]
  assignments: readonly BambuOnboardedAssignment[]
}
export const EMPTY_BAMBU_BINDINGS: BambuOnboardedConfig = Object.freeze({
  version: 1,
  printers: Object.freeze([]),
  assignments: Object.freeze([]),
})

/**
 * Strict reader: every binding, its private credential and its one local
 * assignment must be valid and inside the enrolled scope. Errors never carry
 * a submitted value.
 */
export function parseBambuOnboardedConfig(
  input: unknown,
  scope: { agent_id: string; farm_id: string },
): BambuOnboardedConfig {
  const store = Store.safeParse(input)
  if (!store.success) throw new Error('Invalid Bambu bindings')
  const keys = new Set<string>()
  const serials = new Set<string>()
  const endpoints = new Set<string>()
  const printers = store.data.printers.map((value) => {
    const row =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : {}
    const binding = parseBambuBinding({
      ...row,
      allowedEndpoints: [{ host: row.host, port: row.port }],
    })
    const endpoint = JSON.stringify([binding.host, binding.port])
    if (
      keys.has(binding.printerKey) ||
      serials.has(binding.serial) ||
      endpoints.has(endpoint)
    )
      throw new Error('Duplicate Bambu binding')
    keys.add(binding.printerKey)
    serials.add(binding.serial)
    endpoints.add(endpoint)
    readBambuCredentials(binding)
    return binding
  })
  const ids = new Set<string>()
  for (const assignment of store.data.assignments) {
    if (
      ids.has(assignment.assignment_id) ||
      assignment.agent_id !== scope.agent_id ||
      assignment.farm_id !== scope.farm_id ||
      !keys.has(assignment.printer_key)
    )
      throw new Error('Bambu assignment does not match local scope')
    ids.add(assignment.assignment_id)
  }
  if (
    store.data.assignments.length !== printers.length ||
    new Set(store.data.assignments.map((a) => a.printer_key)).size !==
      printers.length
  )
    throw new Error('Bambu assignment mapping is incomplete')
  return Object.freeze({
    version: 1,
    printers: Object.freeze(printers),
    assignments: Object.freeze(store.data.assignments),
  })
}
