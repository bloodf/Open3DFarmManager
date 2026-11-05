import { z } from 'zod'
import { PairingProofAudience } from '../../../farm-protocol/src/pairing-proof.ts'
import {
  createPrinterBindingRegistry,
  readPrinterBinding,
} from '../control/printer-binding.ts'
import {
  LocalCollectorConfigSchema,
  parseLocalCollectorConfig,
  readPrivateJsonFile,
} from './local.ts'
import { validateMoonrakerInput } from './moonraker.ts'
import type { RuntimeCredential } from './credential.ts'
import { RuntimeSignalling } from './signalling.ts'

const Runtime = z.strictObject({
  version: z.literal(1),
  collection: LocalCollectorConfigSchema,
  assignments: z.array(z.unknown()).min(1).max(16),
  signalling: RuntimeSignalling.optional(),
  telemetry: z
    .strictObject({
      endpoint: z.string().min(1).max(2048),
      audience: PairingProofAudience,
      timeoutMs: z.number().int().min(100).max(60000).default(5000),
      retryMinMs: z.number().int().min(100).max(300000).default(1000),
      retryMaxMs: z.number().int().min(100).max(300000).default(30000),
      idleMs: z.number().int().min(100).max(5000).default(500),
    })
    .refine((value) => value.retryMinMs <= value.retryMaxMs),
})

export function readAgentRuntimeConfig(
  path: string,
  credential: Pick<RuntimeCredential, 'agent_id' | 'farm_id'>,
) {
  const input = Runtime.parse(
    readPrivateJsonFile(path, { maxBytes: 64 * 1024 }),
  )
  const collection = parseLocalCollectorConfig(input.collection)
  const registry = createPrinterBindingRegistry({
    allowedOrigins: collection.allowedOrigins,
  })
  const ids = new Set<string>()
  const assignments = input.assignments.map((value) => {
    const assignment = readPrinterBinding(registry.provision(value))
    if (
      !assignment ||
      ids.has(assignment.assignment_id) ||
      assignment.agent_id !== credential.agent_id ||
      assignment.farm_id !== credential.farm_id
    )
      throw new Error('Runtime assignment does not match local credential')
    ids.add(assignment.assignment_id)
    return assignment
  })
  if (assignments.length !== collection.printers.length)
    throw new Error('Runtime assignment mapping is incomplete')
  for (const printer of collection.printers) {
    const selected = validateMoonrakerInput({
      assignment: printer,
      allowedOrigins: collection.allowedOrigins,
      limits: collection.limits,
    })
    if (
      !assignments.some(
        (assignment) =>
          assignment.printer_key === selected.printerKey &&
          assignment.moonraker_origin === selected.origin,
      )
    )
      throw new Error(
        'Runtime assignment mapping does not match local collection',
      )
  }
  return {
    collection,
    telemetry: input.telemetry,
    assignments,
    signalling: input.signalling,
  }
}
export type AgentRuntimeConfig = ReturnType<typeof readAgentRuntimeConfig>
