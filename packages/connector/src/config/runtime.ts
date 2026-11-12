import { z } from 'zod'
import { PairingProofAudience } from '../../../farm-protocol/src/pairing-proof.ts'
import {
  createPrinterBindingRegistry,
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import {
  LocalCollectorConfigSchema,
  parseLocalCollectorConfig,
  readPrivateJsonFile,
} from './local.ts'
import { validateMoonrakerInput } from './moonraker.ts'
import type { RuntimeCredential } from './credential.ts'
import { parsePauseRuntimeConfig } from './pause.ts'
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
  // Optional: absent means no renewal and the agent stops at credential expiry.
  // Renewal uses the telemetry endpoint origin; only the proof audience differs.
  renewal: z
    .strictObject({
      audience: PairingProofAudience,
      timeoutMs: z.number().int().min(100).max(60000).default(5000),
      retryMinMs: z.number().int().min(100).max(300000).default(1000),
      retryMaxMs: z.number().int().min(100).max(300000).default(30000),
    })
    .refine((value) => value.retryMinMs <= value.retryMaxMs)
    .optional(),
  // The pause section is optional and parsed strictly by its own module. An
  // absent section carries no authority and causes no cryptographic work.
  pause: z.unknown().optional(),
})

export function readAgentRuntimeConfig(
  path: string,
  credential: Pick<RuntimeCredential, 'agent_id' | 'farm_id'>,
) {
  const input = Runtime.parse(
    readPrivateJsonFile(path, { maxBytes: 64 * 1024 }),
  )
  const collection = parseLocalCollectorConfig(input.collection)
  if (collection.spoolman && collection.spoolman.farmId !== credential.farm_id)
    throw new Error('Spoolman scope does not match local credential')
  const registry = createPrinterBindingRegistry({
    allowedOrigins: collection.allowedOrigins,
  })
  const ids = new Set<string>()
  // The exact provisioned handles are retained privately. They are the only
  // source of a printer binding and are never reconstructed or serialized.
  const provisioned = new Map<string, PrinterBinding>()
  const assignments = input.assignments.map((value) => {
    const binding = registry.provision(value)
    const assignment = readPrinterBinding(binding)
    if (
      !assignment ||
      ids.has(assignment.assignment_id) ||
      assignment.agent_id !== credential.agent_id ||
      assignment.farm_id !== credential.farm_id
    )
      throw new Error('Runtime assignment does not match local credential')
    ids.add(assignment.assignment_id)
    provisioned.set(assignment.assignment_id, binding)
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
  const pause =
    input.pause === undefined ? null : parsePauseRuntimeConfig(input.pause)
  if (pause?.control && !provisioned.has(pause.control.assignmentId))
    throw new Error('Pause control assignment is not provisioned locally')
  return {
    collection,
    telemetry: input.telemetry,
    renewal: input.renewal,
    assignments,
    signalling: input.signalling,
    pause,
    /**
     * Local provisioned mapping resolver. It returns the exact handle that was
     * provisioned during this read, and `undefined` for an unknown or foreign
     * assignment id. A local mapping is a provisioning fact, never a statement
     * about the current server assignment permission.
     */
    bindingFor(assignmentId: string): PrinterBinding | undefined {
      return provisioned.get(assignmentId)
    },
  }
}
export type AgentRuntimeConfig = ReturnType<typeof readAgentRuntimeConfig>
