import { dirname, join } from 'node:path'
import { z } from 'zod'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import {
  ConfigurationIpv4,
  CREALITY_NATIVE_PORT,
} from '../../../farm-protocol/src/configuration-target.ts'

export function crealityBindingsPath(runtimeConfigPath: string) {
  return join(dirname(runtimeConfigPath), 'creality-bindings.json')
}
const Store = z.strictObject({
  version: z.literal(1),
  printers: z
    .array(
      z.strictObject({
        printerKey: z.string().min(1).max(128),
        host: ConfigurationIpv4,
        port: z.literal(CREALITY_NATIVE_PORT),
      }),
    )
    .max(16),
  assignments: z
    .array(
      z.strictObject({
        assignment_id: BrowserDeviceUuid,
        farm_id: BrowserDeviceUuid,
        agent_id: BrowserDeviceUuid,
        printer_key: z.string().min(1).max(128),
      }),
    )
    .max(16),
})
export function parseCrealityOnboardedConfig(
  input: unknown,
  scope: { agent_id: string; farm_id: string },
) {
  const parsed = Store.safeParse(input)
  if (!parsed.success) throw new Error('Invalid Creality bindings')
  const store = parsed.data
  const keys = new Set(store.printers.map((p) => p.printerKey))
  if (
    keys.size !== store.printers.length ||
    new Set(store.printers.map((p) => p.host)).size !== keys.size ||
    new Set(store.assignments.map((a) => a.assignment_id)).size !== keys.size ||
    new Set(store.assignments.map((a) => a.printer_key)).size !== keys.size ||
    store.assignments.length !== keys.size ||
    store.assignments.some(
      (a) =>
        a.agent_id !== scope.agent_id ||
        a.farm_id !== scope.farm_id ||
        !keys.has(a.printer_key),
    )
  )
    throw new Error('Creality assignment does not match local scope')
  return store
}
