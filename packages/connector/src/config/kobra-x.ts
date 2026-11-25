import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import { readPrivateJsonFile } from './local.ts'

/**
 * Private native Kobra X bindings written by signed onboarding. They live
 * beside the accepted runtime file. The runtime scopes these bindings to the
 * enrolled farm and agent and resolves their assignments by printer key.
 *
 * A row holds only what is needed to reconnect: the printer address, the
 * identity it proved at onboarding, the private client certificate path and the
 * pinned server-certificate fingerprint. The printer's MQTT credentials are
 * never stored: the Connector recovers them in memory on every connection.
 */
export const KOBRA_X_BINDINGS_FILE = 'kobra-x-bindings.json'
export const KOBRA_X_BINDINGS_MAX_BYTES = 64 * 1024
export const MAX_KOBRA_X_BINDINGS = 16

export function kobraXBindingsPath(runtimeConfigPath: string): string {
  return join(dirname(runtimeConfigPath), KOBRA_X_BINDINGS_FILE)
}

export const KobraXBinding = z.strictObject({
  printerKey: z.string().min(1).max(128),
  host: z.ipv4(),
  modelId: z.string().regex(/^[\w-]{1,128}$/),
  deviceId: z.string().regex(/^[\w-]{1,128}$/),
  clientCertFile: z.string().min(1).max(4096),
  pinSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * Per-printer qualification flag for firmware that answers on
   * `<type>/report` with its own `msgid`, or none (see `KobraXReportIdentity`
   * in kobra-x/requests.ts). Set it only after qualification showed that this
   * printer's firmware does not echo the request ID. Onboarding never writes
   * it: absent means exact IDs.
   */
  reportIdentity: z.literal('printer-assigned').optional(),
})
export type KobraXBinding = z.infer<typeof KobraXBinding>

const Assignment = z.strictObject({
  assignment_id: BrowserDeviceUuid,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  printer_key: z.string().min(1).max(128),
})
export type KobraXOnboardedAssignment = z.infer<typeof Assignment>
const Store = z.strictObject({
  version: z.literal(1),
  printers: z.array(z.unknown()).max(MAX_KOBRA_X_BINDINGS),
  assignments: z.array(Assignment).max(MAX_KOBRA_X_BINDINGS),
})

export interface KobraXOnboardedConfig {
  version: 1
  printers: readonly KobraXBinding[]
  assignments: readonly KobraXOnboardedAssignment[]
}
export const EMPTY_KOBRA_X_BINDINGS: KobraXOnboardedConfig = Object.freeze({
  version: 1,
  printers: Object.freeze([]),
  assignments: Object.freeze([]),
})

/**
 * Strict reader: every binding and its one local assignment must be valid and
 * inside the enrolled scope. Errors never carry a stored value. A missing or
 * invalid client certificate is not a parse error: the collector reports it as
 * a printer status so one expired certificate never hides the other printers.
 */
export function parseKobraXOnboardedConfig(
  input: unknown,
  scope: { agent_id: string; farm_id: string },
): KobraXOnboardedConfig {
  const store = Store.safeParse(input)
  if (!store.success) throw new Error('Invalid Kobra X bindings')
  const keys = new Set<string>()
  const devices = new Set<string>()
  const hosts = new Set<string>()
  const printers = store.data.printers.map((value) => {
    const binding = KobraXBinding.safeParse(value)
    if (!binding.success) throw new Error('Invalid Kobra X binding')
    const device = JSON.stringify([binding.data.modelId, binding.data.deviceId])
    if (
      keys.has(binding.data.printerKey) ||
      devices.has(device) ||
      hosts.has(binding.data.host)
    )
      throw new Error('Duplicate Kobra X binding')
    keys.add(binding.data.printerKey)
    devices.add(device)
    hosts.add(binding.data.host)
    return Object.freeze(binding.data)
  })
  const ids = new Set<string>()
  for (const assignment of store.data.assignments) {
    if (
      ids.has(assignment.assignment_id) ||
      assignment.agent_id !== scope.agent_id ||
      assignment.farm_id !== scope.farm_id ||
      !keys.has(assignment.printer_key)
    )
      throw new Error('Kobra X assignment does not match local scope')
    ids.add(assignment.assignment_id)
  }
  if (
    store.data.assignments.length !== printers.length ||
    new Set(store.data.assignments.map((a) => a.printer_key)).size !==
      printers.length
  )
    throw new Error('Kobra X assignment mapping is incomplete')
  return Object.freeze({
    version: 1,
    printers: Object.freeze(printers),
    assignments: Object.freeze(store.data.assignments),
  })
}

/**
 * Confirmed native bindings for the collector. A missing store means no native
 * printer; an unreadable or invalid one throws so the caller fails closed
 * instead of silently dropping printers.
 */
export function readKobraXOnboardedConfig(
  runtimeConfigPath: string,
  scope: { agent_id: string; farm_id: string },
): KobraXOnboardedConfig {
  const path = kobraXBindingsPath(runtimeConfigPath)
  if (!lstatSync(path, { throwIfNoEntry: false })) return EMPTY_KOBRA_X_BINDINGS
  return parseKobraXOnboardedConfig(
    readPrivateJsonFile(path, { maxBytes: KOBRA_X_BINDINGS_MAX_BYTES }),
    scope,
  )
}
