import { KobraLinkRuntimeBinding } from '../kobralink/configuration.ts'
import { AnycubicBinding } from '../config/anycubic.ts'
import { KobraXBinding } from '../config/kobra-x.ts'
import { CrealityBinding } from '../config/creality.ts'
import { FlashforgeBindingSchema } from '../flashforge/config.ts'
import { sdcpProfile } from '../sdcp/models.ts'
import { parseBambuBinding, type BambuBinding } from '../bambu/configuration.ts'
import { z } from 'zod'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import { PrinterState } from '../../../farm-protocol/src/state.ts'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'

const Assignment = z.strictObject({
  assignment_id: BrowserDeviceUuid,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  printer_key: PrinterState.shape.printerKey.refine((value) => {
    if (value.includes('\0')) return false
    try {
      canonicalize(value)
      return true
    } catch {
      return false
    }
  }),
  moonraker_origin: z.string().max(256),
})
export type LocalPrinterAssignment = Readonly<z.infer<typeof Assignment>>

class BoundPrinter {
  #opaque = true
  constructor() {
    Object.freeze(this)
  }
  toJSON(): never {
    throw new Error('Local printer bindings cannot be serialized')
  }
}
export type PrinterBinding = BoundPrinter
const bindings = new WeakMap<
  PrinterBinding,
  { assignment: LocalPrinterAssignment; active: boolean }
>()

function canonicalOrigin(input: string): string {
  const url = new URL(input)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== input ||
    url.username ||
    url.password
  )
    throw new Error('Expected a canonical allowlisted Moonraker origin')
  return input
}

/** Local provisioning boundary only; neither a message nor a database assignment authenticates an endpoint. */
export function createPrinterBindingRegistry(config: {
  allowedOrigins: readonly string[]
}) {
  if (!config.allowedOrigins.length || config.allowedOrigins.length > 128)
    throw new Error('Invalid local origin allowlist')
  const origins = new Set(config.allowedOrigins.map(canonicalOrigin))
  const assignments = new Map<string, PrinterBinding>()
  return Object.freeze({
    provision(input: unknown): PrinterBinding {
      const assignment = Object.freeze(Assignment.parse(input))
      if (!origins.has(canonicalOrigin(assignment.moonraker_origin)))
        throw new Error('Moonraker origin is not locally allowed')
      const previous = assignments.get(assignment.assignment_id)
      if (previous) {
        const row = bindings.get(previous)
        if (
          !row?.active ||
          Object.keys(assignment).some(
            (key) =>
              Reflect.get(assignment, key) !== Reflect.get(row.assignment, key),
          )
        )
          throw new Error(
            'An assignment cannot be rebound; provision a new assignment',
          )
        return previous
      }
      if (assignments.size >= 1000)
        throw new Error('Local assignment capacity exhausted')
      for (const retained of assignments.values()) {
        const row = bindings.get(retained)
        if (
          row?.active &&
          row.assignment.farm_id === assignment.farm_id &&
          row.assignment.printer_key === assignment.printer_key
        )
          throw new Error('Printer already has an active local assignment')
      }
      const binding = new BoundPrinter()
      bindings.set(binding, { assignment, active: true })
      assignments.set(assignment.assignment_id, binding)
      return binding
    },
    retire(binding: PrinterBinding): void {
      const row = bindings.get(binding)
      if (!row || assignments.get(row.assignment.assignment_id) !== binding)
        throw new Error('Unknown local printer binding')
      row.active = false
    },
  })
}

/** A snapshot carries no independent authority; callers must recheck the opaque binding before use. */
export function readPrinterBinding(
  binding: PrinterBinding,
): LocalPrinterAssignment | null {
  const row = bindings.get(binding)
  return row?.active ? row.assignment : null
}

const ReadonlyAssignment = Assignment.omit({ moonraker_origin: true }).extend({
  backend: z.literal('kobralink'),
  bridgeInstance: z.string().min(1).max(128),
  origin: z.string().max(2048),
  deviceId: z.string().min(1).max(128),
  id: z.string().min(1).max(128),
  revision: z.number().int().positive(),
})
const SdcpAssignment = Assignment.omit({ moonraker_origin: true }).extend({
  backend: z.enum([
    'sdcp',
    'formlabs',
    'prusa-link',
    'flashforge',
    'phrozen',
    'qidi',
    'anycubic-resin',
  ]),
})
const readonlyBindings = new WeakMap<
  PrinterBinding,
  z.infer<typeof ReadonlyAssignment> | z.infer<typeof SdcpAssignment>
>()
/** Read-only handles deliberately have no Moonraker command mapping. */
export function provisionReadonlyPrinter(input: unknown): PrinterBinding {
  const value = Object.freeze(
    z.union([ReadonlyAssignment, SdcpAssignment]).parse(input),
  )
  const binding = new BoundPrinter()
  readonlyBindings.set(binding, value)
  return binding
}
export function readRuntimePrinterBinding(binding: PrinterBinding) {
  const mapping = readPrinterBinding(binding)
  if (mapping && readKobraXPrinterBinding(binding)) {
    const { assignment_id, farm_id, agent_id, printer_key } = mapping
    return {
      assignment_id,
      farm_id,
      agent_id,
      printer_key,
      backend: 'kobra-x' as const,
    }
  }
  const local = mapping ? kobraLinkBindings.get(binding) : undefined
  if (mapping && local) {
    const { assignment_id, farm_id, agent_id, printer_key } = mapping
    return {
      assignment_id,
      farm_id,
      agent_id,
      printer_key,
      backend: local.backend,
      bridgeInstance: local.bridgeInstance,
      origin: local.origin,
      deviceId: local.deviceId,
      id: local.id,
      revision: local.revision,
    }
  }
  if (mapping && sdcpBindings.has(binding)) {
    const { assignment_id, farm_id, agent_id, printer_key } = mapping
    return {
      assignment_id,
      farm_id,
      agent_id,
      printer_key,
      backend: 'sdcp' as const,
    }
  }
  if (mapping && flashforgeBindings.has(binding)) {
    const { assignment_id, farm_id, agent_id, printer_key } = mapping
    return {
      assignment_id,
      farm_id,
      agent_id,
      printer_key,
      backend: 'flashforge' as const,
    }
  }
  if (mapping && photonResinBindings.has(binding)) {
    const { assignment_id, farm_id, agent_id, printer_key } = mapping
    return {
      assignment_id,
      farm_id,
      agent_id,
      printer_key,
      backend: 'anycubic-resin' as const,
    }
  }
  return mapping ?? readonlyBindings.get(binding) ?? null
}

const flashforgeBindings = new WeakMap<
  PrinterBinding,
  Readonly<z.infer<typeof FlashforgeBindingSchema>>
>()
/** Explicit local command opt-in; other Flashforge handles stay read-only. */
export function provisionFlashforgePrinter(
  assignmentInput: unknown,
  bindingInput: unknown,
): PrinterBinding {
  const local = Object.freeze(FlashforgeBindingSchema.parse(bindingInput))
  const scope = Assignment.omit({ moonraker_origin: true }).parse(
    assignmentInput,
  )
  if (scope.printer_key !== local.printerKey)
    throw new Error('Flashforge assignment mismatch')
  const binding = new BoundPrinter()
  bindings.set(binding, {
    assignment: Object.freeze({ ...scope, moonraker_origin: '' }),
    active: true,
  })
  flashforgeBindings.set(binding, local)
  return binding
}
export function readFlashforgePrinterBinding(binding: PrinterBinding) {
  return readPrinterBinding(binding)
    ? (flashforgeBindings.get(binding) ?? null)
    : null
}

const PhotonResinControlBinding = z.strictObject({
  printerKey: z.string().min(1).max(128),
  model: z.string().min(1).max(128),
})
const photonResinBindings = new WeakMap<
  PrinterBinding,
  Readonly<z.infer<typeof PhotonResinControlBinding>>
>()
/** Explicit local command opt-in; other resin handles stay read-only. */
export function provisionPhotonResinPrinter(
  assignmentInput: unknown,
  bindingInput: unknown,
): PrinterBinding {
  const local = Object.freeze(PhotonResinControlBinding.parse(bindingInput))
  const scope = Assignment.omit({ moonraker_origin: true }).parse(
    assignmentInput,
  )
  if (scope.printer_key !== local.printerKey)
    throw new Error('Anycubic resin assignment mismatch')
  const binding = new BoundPrinter()
  bindings.set(binding, {
    assignment: Object.freeze({ ...scope, moonraker_origin: '' }),
    active: true,
  })
  photonResinBindings.set(binding, local)
  return binding
}
export function readPhotonResinPrinterBinding(binding: PrinterBinding) {
  return readPrinterBinding(binding)
    ? (photonResinBindings.get(binding) ?? null)
    : null
}

const SdcpControlBinding = z.strictObject({
  printerKey: z.string().min(1).max(128),
  host: z.ipv4(),
  mainboardId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  model: z
    .string()
    .min(1)
    .max(128)
    .refine((model) => sdcpProfile(model) !== undefined),
  discoveryPort: z.number().int().min(1).max(65535).optional(),
  websocketPort: z.number().int().min(1).max(65535).optional(),
  uploadPort: z.number().int().min(1).max(65535).optional(),
})
const sdcpBindings = new WeakMap<
  PrinterBinding,
  Readonly<z.infer<typeof SdcpControlBinding>>
>()
/** Explicit local command opt-in; other SDCP handles stay read-only. */
export function provisionSdcpPrinter(
  assignmentInput: unknown,
  bindingInput: unknown,
): PrinterBinding {
  const local = Object.freeze(SdcpControlBinding.parse(bindingInput))
  const scope = Assignment.omit({ moonraker_origin: true }).parse(
    assignmentInput,
  )
  if (scope.printer_key !== local.printerKey)
    throw new Error('SDCP assignment mismatch')
  const binding = new BoundPrinter()
  bindings.set(binding, {
    assignment: Object.freeze({ ...scope, moonraker_origin: '' }),
    active: true,
  })
  sdcpBindings.set(binding, local)
  return binding
}
export function readSdcpPrinterBinding(binding: PrinterBinding) {
  return readPrinterBinding(binding)
    ? (sdcpBindings.get(binding) ?? null)
    : null
}

const bambuBindings = new WeakMap<PrinterBinding, BambuBinding>()
/** Trusted local provisioning only. An empty Moonraker origin cannot select an HTTP endpoint. */
export function provisionBambuPrinter(
  assignmentInput: unknown,
  bindingInput: unknown,
): PrinterBinding {
  const local = parseBambuBinding(bindingInput)
  const scope = Assignment.omit({ moonraker_origin: true }).parse(
    assignmentInput,
  )
  if (scope.printer_key !== local.printerKey)
    throw new Error('Bambu assignment mismatch')
  const binding = new BoundPrinter()
  bindings.set(binding, {
    assignment: Object.freeze({ ...scope, moonraker_origin: '' }),
    active: true,
  })
  bambuBindings.set(binding, local)
  return binding
}
export function readBambuPrinterBinding(
  binding: PrinterBinding,
): BambuBinding | null {
  return readPrinterBinding(binding)
    ? (bambuBindings.get(binding) ?? null)
    : null
}

const crealityBindings = new WeakMap<
  PrinterBinding,
  Readonly<import('zod').infer<typeof CrealityBinding>>
>()
export function provisionCrealityPrinter(
  assignmentInput: unknown,
  bindingInput: unknown,
): PrinterBinding {
  const local = Object.freeze(CrealityBinding.parse(bindingInput))
  const scope = Assignment.omit({ moonraker_origin: true }).parse(
    assignmentInput,
  )
  if (scope.printer_key !== local.printerKey)
    throw new Error('Creality assignment mismatch')
  const binding = new BoundPrinter()
  bindings.set(binding, {
    assignment: Object.freeze({ ...scope, moonraker_origin: '' }),
    active: true,
  })
  crealityBindings.set(binding, local)
  return binding
}
export function readCrealityPrinterBinding(binding: PrinterBinding) {
  return readPrinterBinding(binding)
    ? (crealityBindings.get(binding) ?? null)
    : null
}

const AnycubicControlBinding = AnycubicBinding.extend({
  caFile: z.string().min(1).max(4096).optional(),
  pinSha256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
})
const anycubicBindings = new WeakMap<
  PrinterBinding,
  z.infer<typeof AnycubicControlBinding>
>()
export function provisionAnycubicPrinter(
  assignmentInput: unknown,
  bindingInput: unknown,
): PrinterBinding {
  const local = Object.freeze(AnycubicControlBinding.parse(bindingInput))
  const scope = Assignment.omit({ moonraker_origin: true }).parse(
    assignmentInput,
  )
  if (scope.printer_key !== local.printerKey)
    throw Error('Anycubic assignment mismatch')
  const binding = new BoundPrinter()
  bindings.set(binding, {
    assignment: Object.freeze({ ...scope, moonraker_origin: '' }),
    active: true,
  })
  anycubicBindings.set(binding, local)
  return binding
}
export function readAnycubicPrinterBinding(binding: PrinterBinding) {
  return readPrinterBinding(binding)
    ? (anycubicBindings.get(binding) ?? null)
    : null
}

const kobraXBindings = new WeakMap<PrinterBinding, Readonly<KobraXBinding>>()

export function provisionKobraXPrinter(
  assignmentInput: unknown,
  bindingInput: unknown,
): PrinterBinding {
  const local = Object.freeze(KobraXBinding.parse(bindingInput))
  const scope = Assignment.omit({ moonraker_origin: true }).parse(
    assignmentInput,
  )
  if (scope.printer_key !== local.printerKey || local.modelId !== '20030')
    throw new Error('Kobra X assignment mismatch')
  const binding = new BoundPrinter()
  bindings.set(binding, {
    assignment: Object.freeze({ ...scope, moonraker_origin: '' }),
    active: true,
  })
  kobraXBindings.set(binding, local)
  return binding
}

export function readKobraXPrinterBinding(binding: PrinterBinding) {
  return readPrinterBinding(binding)
    ? (kobraXBindings.get(binding) ?? null)
    : null
}

const kobraLinkBindings = new WeakMap<
  PrinterBinding,
  import('../kobralink/configuration.ts').KobraLinkRuntimeBinding
>()
/** Explicit local command opt-in; read-only snapshot handles remain inert. */
export function provisionKobraLinkPrinter(
  assignmentInput: unknown,
  bindingInput: unknown,
): PrinterBinding {
  const local = Object.freeze(KobraLinkRuntimeBinding.parse(bindingInput))
  const scope = Assignment.omit({ moonraker_origin: true }).parse(
    assignmentInput,
  )
  if (scope.printer_key !== local.printerKey)
    throw new Error('KobraLink assignment mismatch')
  const binding = new BoundPrinter()
  bindings.set(binding, {
    assignment: Object.freeze({ ...scope, moonraker_origin: '' }),
    active: true,
  })
  kobraLinkBindings.set(binding, local)
  return binding
}
export function readKobraLinkPrinterBinding(binding: PrinterBinding) {
  return readPrinterBinding(binding)
    ? (kobraLinkBindings.get(binding) ?? null)
    : null
}
