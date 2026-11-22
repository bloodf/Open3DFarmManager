import { parseCollectorConfig } from './sdcp.ts'
import {
  provisionBambuPrinter,
  provisionAnycubicPrinter,
  provisionCrealityPrinter,
} from '../control/printer-binding.ts'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { PairingProofAudience } from '../../../farm-protocol/src/pairing-proof.ts'
import {
  createPrinterBindingRegistry,
  readRuntimePrinterBinding,
  readPrinterBinding,
  provisionReadonlyPrinter,
  provisionKobraLinkPrinter,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import { readVersionedRuntimeConfig } from './version.ts'
import { validateMoonrakerInput } from './moonraker.ts'
import type { RuntimeCredential } from './credential.ts'
import { parsePauseRuntimeConfig } from './pause.ts'
import { RuntimeSignalling } from './signalling.ts'
import { parseCameraRuntimeConfig } from './camera.ts'
import { parseRtcRuntimeConfig } from './rtc.ts'

const LibraryRuntime = z.strictObject({
  /** Absolute directory of the Connector library store. */
  directory: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isAbsolute(value) && !value.includes('\0'))
    .optional(),
  quotaBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  keepVersions: z.number().int().min(1).max(1000).optional(),
  /** Bound of the server-mode download cache. */
  cacheMaxBytes: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
})
export type LibraryRuntimeConfig = z.infer<typeof LibraryRuntime>

const Runtime = z.strictObject({
  version: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
  ]),
  collection: z.unknown(),
  assignments: z.array(z.unknown()).min(1).max(16),
  signalling: RuntimeSignalling.optional(),
  discovery: z
    .strictObject({
      enabled: z.boolean().default(true),
      intervalMs: z.number().int().min(1).max(2147483647).default(600_000),
    })
    .prefault({}),
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
  // Opt-in camera media; absent means no track, channel or ingest helper.
  camera: z.unknown().optional(),
  // Optional ICE bind address; absent keeps loopback (config/rtc.ts).
  rtc: z.unknown().optional(),
  // Optional library store settings (#446). Absent keeps the defaults: the
  // store lives under `<data directory>/library`, with the server's quota.
  library: LibraryRuntime.optional(),
})

export function readAgentRuntimeConfig(
  path: string,
  credential: Pick<RuntimeCredential, 'agent_id' | 'farm_id'>,
) {
  const input = Runtime.parse(readVersionedRuntimeConfig(path, false))
  const collection = parseCollectorConfig(input.collection)
  if (input.version !== collection.version)
    throw Error('Runtime collection version mismatch')
  if (collection.spoolman && collection.spoolman.farmId !== credential.farm_id)
    throw new Error('Spoolman scope does not match local credential')
  const registry = collection.allowedOrigins.length
    ? createPrinterBindingRegistry({
        allowedOrigins: collection.allowedOrigins,
      })
    : null
  const pause =
    input.pause === undefined ? null : parsePauseRuntimeConfig(input.pause)
  const ids = new Set<string>()
  // The exact provisioned handles are retained privately. They are the only
  // source of a printer binding and are never reconstructed or serialized.
  const provisioned = new Map<string, PrinterBinding>()
  const assignments = input.assignments.map((value) => {
    const isKobra =
      collection.version === 2 &&
      typeof value === 'object' &&
      value !== null &&
      'backend' in value &&
      value.backend === 'kobralink'
    const bambu =
      collection.version === 3
        ? collection.bambu.printers.find(
            (p) =>
              typeof value === 'object' &&
              value !== null &&
              'printer_key' in value &&
              value.printer_key === p.printerKey,
          )
        : undefined
    const creality =
      collection.version === 4
        ? collection.creality.printers.find(
            (p) =>
              typeof value === 'object' &&
              value !== null &&
              'printer_key' in value &&
              value.printer_key === p.printerKey,
          )
        : undefined
    const anycubic =
      collection.version === 5
        ? collection.anycubic.printers.find(
            (p) =>
              typeof value === 'object' &&
              value !== null &&
              'printer_key' in value &&
              value.printer_key === p.printerKey,
          )
        : undefined
    const sdcp =
      collection.version === 6 &&
      typeof value === 'object' &&
      value !== null &&
      'printer_key' in value
        ? collection.sdcp.printers.find(
            (p) => p.printerKey === value.printer_key,
          )
        : undefined
    const binding = sdcp
      ? (() => {
          if (
            !value ||
            typeof value !== 'object' ||
            !('backend' in value) ||
            value.backend !== 'sdcp'
          )
            throw Error('SDCP assignment mismatch')
          return provisionReadonlyPrinter(value)
        })()
      : bambu
        ? provisionBambuPrinter(value, bambu)
        : anycubic
          ? provisionAnycubicPrinter(value, anycubic)
          : creality
            ? provisionCrealityPrinter(value, creality)
            : isKobra
              ? (() => {
                  const readonly = provisionReadonlyPrinter(value)
                  const assignment = readRuntimePrinterBinding(readonly)!
                  if (
                    !pause?.control?.assignmentIds.includes(
                      assignment.assignment_id,
                    ) ||
                    collection.version !== 2
                  )
                    return readonly
                  const local = collection.kobralink.printers.find(
                    (p) => p.printerKey === assignment.printer_key,
                  )
                  if (
                    !local ||
                    !('backend' in assignment) ||
                    assignment.backend !== 'kobralink' ||
                    assignment.origin !== local.origin ||
                    assignment.bridgeInstance !== local.bridgeInstance ||
                    assignment.deviceId !== local.deviceId ||
                    assignment.id !== local.id ||
                    assignment.revision !== local.revision
                  )
                    throw new Error('KobraLink assignment mismatch')
                  const { assignment_id, farm_id, agent_id, printer_key } =
                    assignment
                  return provisionKobraLinkPrinter(
                    { assignment_id, farm_id, agent_id, printer_key },
                    local,
                  )
                })()
              : registry?.provision(value)
    if (!binding) throw Error('Moonraker assignment requires local allowlist')
    const assignment = readRuntimePrinterBinding(binding)
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
  if (
    assignments.length !==
    collection.printers.length +
      (collection.version === 6
        ? collection.sdcp.printers.length
        : collection.version === 5
          ? collection.anycubic.printers.length
          : collection.version === 4
            ? collection.creality.printers.length
            : collection.version === 3
              ? collection.bambu.printers.length
              : collection.version === 2
                ? collection.kobralink.printers.length
                : 0)
  )
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
          'moonraker_origin' in assignment &&
          assignment.moonraker_origin === selected.origin,
      )
    )
      throw new Error(
        'Runtime assignment mapping does not match local collection',
      )
  }
  if (collection.version === 6) {
    for (const printer of collection.sdcp.printers) {
      if (
        assignments.filter(
          (a) =>
            a.printer_key === printer.printerKey &&
            'backend' in a &&
            a.backend === 'sdcp',
        ).length !== 1
      )
        throw Error('SDCP assignment mismatch')
    }
  }
  if (collection.version === 2) {
    for (const printer of collection.kobralink.printers) {
      const matches = assignments.filter(
        (a) =>
          'backend' in a &&
          a.backend === 'kobralink' &&
          a.printer_key === printer.printerKey &&
          a.origin === printer.origin &&
          a.bridgeInstance === printer.bridgeInstance &&
          a.deviceId === printer.deviceId &&
          a.id === printer.id &&
          a.revision === printer.revision,
      )
      if (matches.length !== 1) throw Error('KobraLink assignment mismatch')
    }
  }
  for (const assignmentId of pause?.control?.assignmentIds ?? []) {
    if (!provisioned.has(assignmentId))
      throw new Error('Pause control assignment is not provisioned locally')
    const binding = provisioned.get(assignmentId)
    if (!binding || !readPrinterBinding(binding))
      throw Error('Backend does not support pause control')
  }
  const camera =
    input.camera === undefined
      ? null
      : parseCameraRuntimeConfig(
          input.camera,
          // Cameras attach to any local printer except KobraLink bridges.
          assignments
            .filter(
              (assignment) =>
                !(
                  'backend' in assignment && assignment.backend === 'kobralink'
                ),
            )
            .map((assignment) => assignment.assignment_id),
        )
  // Strict: an invalid address fails startup before any task starts.
  const rtc = parseRtcRuntimeConfig(input.rtc)
  return {
    camera,
    rtc,
    collection,
    telemetry: input.telemetry,
    discovery: input.discovery,
    renewal: input.renewal,
    assignments,
    signalling: input.signalling,
    ...(input.library ? { library: input.library } : {}),
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
