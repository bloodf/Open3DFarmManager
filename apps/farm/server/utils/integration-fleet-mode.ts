import { randomUUID } from 'node:crypto'
import { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { z } from 'zod'
import {
  uuidPattern,
  type IntegrationPrincipal,
  type IntegrationPrinterRow,
} from './integration-auth.ts'
import { integrationGrantFor } from './integration-auth-http.ts'
import {
  printerDegradedReason,
  qualifyPrinter,
} from './integration-capabilities.ts'
import { observationIsStale } from './integration-environment.ts'

const mode = z.enum(['in-service', 'maintenance'])
const uuid = z.string().toLowerCase().regex(uuidPattern)
const target = z.strictObject({
  printerId: uuid,
  expectedVersion: uuid.nullable(),
})

export const fleetModeRequest = z
  .discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('set'),
      mode,
      targets: z.array(target).min(1).max(50),
    }),
    z.strictObject({
      action: z.literal('restore'),
      targets: z
        .array(target.extend({ expectedVersion: uuid }))
        .min(1)
        .max(50),
    }),
  ])
  .refine(
    ({ targets }) =>
      new Set(targets.map(({ printerId }) => printerId)).size ===
      targets.length,
  )

export type FleetMode = z.infer<typeof mode>
export type FleetModeRequest = z.infer<typeof fleetModeRequest>

export interface FleetModeRecord {
  mode: FleetMode
  version: string
  previousMode: FleetMode | null
  appId: string
}

export interface FleetModeStore {
  read(printerId: string): Promise<FleetModeRecord | null>
  compareAndSet(input: {
    printerId: string
    grantId: string
    expectedVersion: string | null
    next: FleetModeRecord
  }): Promise<boolean>
}

type Reader = (printerId: string) => Promise<IntegrationPrinterRow | null>
type Scope = 'printers:read' | 'control:extended'

async function scopedPrinter(
  principal: IntegrationPrincipal,
  read: Reader,
  printerId: string,
  scope: Scope,
) {
  const printer = await read(printerId)
  if (!printer) return null
  const grant = integrationGrantFor(
    principal,
    scope,
    printer.farmId,
    printer.id,
  )
  return grant ? { printer, grant } : null
}

const defaultMode = 'in-service'
const labels = {
  'in-service': 'Em serviço',
  maintenance: 'Em manutenção',
} as const

export function modeView(printerId: string, current: FleetModeRecord | null) {
  const mode = current?.mode ?? defaultMode
  return {
    printerId,
    mode,
    label: labels[mode],
    version: current?.version ?? null,
  }
}

export async function readFleetMode(
  principal: IntegrationPrincipal,
  read: Reader,
  store: FleetModeStore,
  printerId: string,
) {
  const scope = await scopedPrinter(principal, read, printerId, 'printers:read')
  return scope ? modeView(printerId, await store.read(printerId)) : null
}

type Outcome =
  | ({ outcome: 'applied' } & ReturnType<typeof modeView>)
  | {
      outcome: 'unsupported'
      printerId: string
      reason: 'capability-unqualified'
    }
  | {
      outcome: 'denied'
      printerId: string
      reason:
        | 'not-found'
        | 'approval-required'
        | 'observation-unavailable'
        | 'version-conflict'
        | 'not-reversible'
        | 'mode-unchanged'
    }

export async function changeFleetMode(
  principal: IntegrationPrincipal,
  read: Reader,
  store: FleetModeStore,
  request: FleetModeRequest,
  now = Date.now(),
): Promise<{ data: Outcome[] } | null> {
  const scopes = await Promise.all(
    request.targets.map(({ printerId }) =>
      scopedPrinter(principal, read, printerId, 'control:extended'),
    ),
  )
  if (scopes.every((scope) => scope === null)) return null

  const outcomes = new Map<string, Outcome>()
  // Every batch acquires write locks in the same order. Return the requested order.
  const ordered = request.targets
    .map((target, index) => ({ target, scope: scopes[index] }))
    .sort((a, b) => a.target.printerId.localeCompare(b.target.printerId))
  for (const {
    target: { printerId, expectedVersion },
    scope,
  } of ordered) {
    const deny = (reason: Extract<Outcome, { outcome: 'denied' }>['reason']) =>
      outcomes.set(printerId, { printerId, outcome: 'denied', reason })
    if (!scope) {
      deny('not-found')
      continue
    }
    if (scope.grant.requiresApproval) {
      deny('approval-required')
      continue
    }
    const state = PrinterState.safeParse(scope.printer.state)
    const observedAt = scope.printer.observedAt ?? state.data?.observedAt
    if (
      !state.success ||
      observedAt === undefined ||
      observedAt < (scope.printer.assignedAt ?? 0) ||
      printerDegradedReason(state.data) ||
      observationIsStale(observedAt, now)
    ) {
      deny('observation-unavailable')
      continue
    }
    // A qualified observation is enough for this metadata operation. The
    // advertised action establishes driver capability and is never executed.
    const { operation } = qualifyPrinter(state.data)
    if (
      (operation !== 'supported-control' && operation !== 'monitoring-only') ||
      !state.data.controls?.includes('start_print')
    ) {
      outcomes.set(printerId, {
        printerId,
        outcome: 'unsupported',
        reason: 'capability-unqualified',
      })
      continue
    }
    const current = await store.read(printerId)
    if ((current?.version ?? null) !== expectedVersion) {
      deny('version-conflict')
      continue
    }
    const previousMode = current?.mode ?? defaultMode
    const nextMode =
      request.action === 'set'
        ? request.mode
        : current?.appId === principal.appId
          ? current.previousMode
          : null
    if (!nextMode) {
      deny('not-reversible')
      continue
    }
    if (nextMode === previousMode) {
      deny('mode-unchanged')
      continue
    }
    const next = {
      mode: nextMode,
      version: randomUUID(),
      previousMode: request.action === 'set' ? previousMode : null,
      appId: principal.appId,
    }
    if (
      !(await store.compareAndSet({
        printerId,
        grantId: scope.grant.id,
        expectedVersion,
        next,
      }))
    ) {
      deny('version-conflict')
      continue
    }
    outcomes.set(printerId, {
      outcome: 'applied',
      ...modeView(printerId, next),
    })
  }
  return {
    data: request.targets.map(({ printerId }) => outcomes.get(printerId)!),
  }
}
