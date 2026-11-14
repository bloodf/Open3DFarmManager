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
const readonlyBindings = new WeakMap<
  PrinterBinding,
  z.infer<typeof ReadonlyAssignment>
>()
/** Read-only handles deliberately have no Moonraker command mapping. */
export function provisionReadonlyPrinter(input: unknown): PrinterBinding {
  const value = Object.freeze(ReadonlyAssignment.parse(input))
  const binding = new BoundPrinter()
  readonlyBindings.set(binding, value)
  return binding
}
export function readRuntimePrinterBinding(binding: PrinterBinding) {
  return readPrinterBinding(binding) ?? readonlyBindings.get(binding) ?? null
}
