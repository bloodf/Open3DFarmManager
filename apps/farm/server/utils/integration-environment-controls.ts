import { createHash, randomUUID } from 'node:crypto'
import { PrinterState } from '@open3dfarmmanager/farm-protocol'
import {
  ApiEnvironmentAction,
  type ApiEnvelopeRefusalCode,
} from '../../../../packages/farm-protocol/src/api-envelope.ts'
import { integrationGrantFor } from './integration-auth-http.ts'
import {
  uuidPattern,
  type IntegrationPrincipal,
  type IntegrationPrinterRow,
} from './integration-auth.ts'
import {
  environmentForPrinter,
  listIntegrationEnvironment,
  observationIsStale,
  type EnvironmentMeasurement,
} from './integration-environment.ts'
import type { IntegrationPrinterReader } from './integration-printers.ts'

/**
 * Environment controls (#693): drying programs, smart plugs and extraction.
 * OpenFarm keeps safety interlocks and credential enrollment; an app gets the
 * observed readiness, a management link into OpenFarm and, where a qualified
 * Connector capability exists, a signed `environment:control` command whose
 * real outcome it can read back. The Connector enforces the interlocks and
 * refuses with a reason. Nothing is retried automatically.
 */
export type EnvironmentControlKind = 'drying' | 'plug' | 'extraction'
export const ENVIRONMENT_CONTROL_KINDS: readonly EnvironmentControlKind[] = [
  'drying',
  'plug',
  'extraction',
]
export type EnvironmentControlReadiness =
  'ready' | 'not-ready' | 'stale' | 'unsupported'
export type EnvironmentControlReason =
  | 'never-observed'
  | 'offline'
  | 'stale'
  | 'printer-error'
  | 'no-qualified-capability'

export interface EnvironmentControlView {
  kind: EnvironmentControlKind
  readiness: EnvironmentControlReadiness
  reason?: EnvironmentControlReason
  /** The Connector's last observation of the device, when it reports one. */
  observed?: EnvironmentMeasurement
  /** Actions this app may request now; empty without `environment:control` or a qualified capability. */
  actions: string[]
  /** Where to manage the device, its setup and its safety rules in OpenFarm. */
  managementUrl: string
}

export interface EnvironmentControlPrinter {
  printerId: string
  farmId: string
  printerKey: string
  displayName?: string
  location?: string
  controls: EnvironmentControlView[]
}

/** The OpenFarm printer page, which owns device setup and safety rules. */
export function environmentManagementUrl(row: {
  farmId: string
  printerKey: string
}) {
  return `/impressoras/${encodeURIComponent(row.printerKey)}?farm=${row.farmId}`
}

const CONTROL_ACTIONS: Record<EnvironmentControlKind, readonly string[]> = {
  extraction: ['set'],
  plug: ['on', 'off'],
  drying: ['start', 'stop'],
}

/**
 * Readiness from the last reported state. Extraction is qualified when the
 * Connector advertises `set_fan` and reports a chamber fan. Smart plugs and
 * drying programs have no qualified Connector capability yet, so they are
 * `unsupported` whatever the printer reports.
 */
function readinessOf(
  kind: EnvironmentControlKind,
  row: IntegrationPrinterRow,
  now: number,
): {
  readiness: EnvironmentControlReadiness
  reason?: EnvironmentControlReason
} {
  if (kind !== 'extraction')
    return { readiness: 'unsupported', reason: 'no-qualified-capability' }
  const parsed = PrinterState.safeParse(row.state)
  if (!parsed.success)
    return { readiness: 'not-ready', reason: 'never-observed' }
  const state = parsed.data
  if (state.state === 'offline' || state.linkHealth?.state === 'offline')
    return { readiness: 'not-ready', reason: 'offline' }
  if (observationIsStale(state.observedAt, now))
    return { readiness: 'stale', reason: 'stale' }
  if (!state.controls?.includes('set_fan') || state.fans?.chamber === undefined)
    return { readiness: 'unsupported', reason: 'no-qualified-capability' }
  if (state.state === 'error' || state.state === 'unknown')
    return { readiness: 'not-ready', reason: 'printer-error' }
  return { readiness: 'ready' }
}

export function environmentControlsForPrinter(
  principal: IntegrationPrincipal,
  row: IntegrationPrinterRow,
  now: number,
): EnvironmentControlPrinter {
  const measurements = environmentForPrinter(row, now).measurements
  const canControl = !!integrationGrantFor(
    principal,
    'environment:control',
    row.farmId,
    row.id,
  )
  const managementUrl = environmentManagementUrl(row)
  return {
    printerId: row.id,
    farmId: row.farmId,
    printerKey: row.printerKey,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.location ? { location: row.location } : {}),
    controls: ENVIRONMENT_CONTROL_KINDS.map((kind) => {
      const { readiness, reason } = readinessOf(kind, row, now)
      const observed =
        kind === 'extraction'
          ? measurements.find((entry) => entry.kind === 'air')
          : kind === 'plug'
            ? measurements.find((entry) => entry.kind === 'power')
            : undefined
      return {
        kind,
        readiness,
        ...(reason ? { reason } : {}),
        ...(observed ? { observed } : {}),
        actions:
          canControl && readiness !== 'unsupported'
            ? [...CONTROL_ACTIONS[kind]]
            : [],
        managementUrl,
      }
    }),
  }
}

/** `GET /environment/controls`: same grant scoping and pagination as measurements. */
export async function listIntegrationEnvironmentControls(
  principal: IntegrationPrincipal,
  reader: Pick<IntegrationPrinterReader, 'readPrinters'>,
  query: URLSearchParams,
  now: number = Date.now(),
) {
  // The page is computed over grants that hold either environment scope.
  const viewer: IntegrationPrincipal = {
    ...principal,
    grants: principal.grants.map((grant) =>
      grant.scopes.includes('environment:read') ||
      !grant.scopes.includes('environment:control')
        ? grant
        : { ...grant, scopes: [...grant.scopes, 'environment:read'] },
    ),
  }
  const rows: IntegrationPrinterRow[] = []
  const page = await listIntegrationEnvironment(
    viewer,
    {
      readPrinters: async (input) => {
        const result = await reader.readPrinters(input)
        rows.push(...result)
        return result
      },
    },
    query,
    now,
  )
  if ('error' in page && page.error) return page
  const byId = new Map(rows.map((row) => [row.id, row]))
  return {
    data: (page.data ?? []).flatMap((entry) => {
      const row = byId.get(entry.printerId)
      return row ? [environmentControlsForPrinter(principal, row, now)] : []
    }),
    nextCursor: page.nextCursor ?? null,
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */

export type EnvironmentControlRequest =
  | { control: 'extraction'; action: 'set'; args: { percent: number } }
  | { control: 'plug'; action: 'on' | 'off'; args: { device: string } }
  | {
      control: 'drying'
      action: 'start'
      args: { targetCelsius: number; durationMinutes: number }
    }
  | { control: 'drying'; action: 'stop'; args: Record<string, never> }

/** The request as a signed-envelope action, or null when it is malformed. */
export function parseEnvironmentControlRequest(
  body: unknown,
): { request: EnvironmentControlRequest; action: ApiEnvironmentAction } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const input = body as Record<string, unknown>
  if (
    Object.keys(input).some(
      (key) => !['control', 'action', 'args'].includes(key),
    )
  )
    return null
  const args = input.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const a = args as Record<string, unknown>
  let candidate: unknown
  if (input.control === 'extraction' && input.action === 'set')
    candidate = { action: 'extraction_set', args: a }
  else if (
    input.control === 'plug' &&
    (input.action === 'on' || input.action === 'off')
  ) {
    if (Object.keys(a).some((key) => key !== 'device')) return null
    candidate = {
      action: 'plug_switch',
      args: { device: a.device, on: input.action === 'on' },
    }
  } else if (input.control === 'drying' && input.action === 'start')
    candidate = { action: 'drying_start', args: a }
  else if (input.control === 'drying' && input.action === 'stop')
    candidate = { action: 'drying_stop', args: a }
  else return null
  const parsed = ApiEnvironmentAction.safeParse(candidate)
  if (!parsed.success) return null
  return {
    request: {
      control: input.control,
      action: input.action,
      args: a,
    } as EnvironmentControlRequest,
    action: parsed.data,
  }
}

export function environmentRequestOf(
  action: ApiEnvironmentAction,
): EnvironmentControlRequest {
  switch (action.action) {
    case 'extraction_set':
      return { control: 'extraction', action: 'set', args: action.args }
    case 'plug_switch':
      return {
        control: 'plug',
        action: action.args.on ? 'on' : 'off',
        args: { device: action.args.device },
      }
    case 'drying_start':
      return { control: 'drying', action: 'start', args: action.args }
    case 'drying_stop':
      return { control: 'drying', action: 'stop', args: {} }
  }
}

export interface EnvironmentControlRecord {
  id: string
  appId: string
  grantId: string
  farmId: string
  printerAssignmentId: string
  printerKey: string
  idempotencyKey: string
  requestHash: string
  action: ApiEnvironmentAction
  createdAt: number
  updatedAt: number
}
export interface EnvironmentControlEnvelope {
  cmdId: string
  /** The delivery status, as recorded for every signed envelope. */
  status: string
  refusalCode: ApiEnvelopeRefusalCode | null
  resultDetail: string | null
  updatedAt: number
}
export interface EnvironmentControlStore {
  existing(
    appId: string,
    idempotencyKey: string,
  ): Promise<{
    record: EnvironmentControlRecord
    envelope: EnvironmentControlEnvelope | null
  } | null>
  /** Inserts once per app and idempotency key; a concurrent duplicate returns the stored record. */
  create(
    record: EnvironmentControlRecord,
  ): Promise<{ kind: 'created' | 'existing'; record: EnvironmentControlRecord }>
  get(
    id: string,
    appId: string,
  ): Promise<{
    record: EnvironmentControlRecord
    envelope: EnvironmentControlEnvelope | null
  } | null>
}
export interface EnvironmentControlEnvelopes {
  /** Issues the one issuer-signed `environment:control` envelope for this action. */
  issue(input: {
    appId: string
    grantId: string
    farmId: string
    agentId: string
    printerAssignmentId: string
    resourceId: string
    ttlMs: number
    action: ApiEnvironmentAction
  }): Promise<
    | { ok: true; created: boolean; envelope: EnvironmentControlEnvelope }
    | { ok: false; reason: 'invalid' | 'refused' }
  >
  /** One delivery attempt; an uncertain write is never resent. */
  deliver(cmdId: string): Promise<unknown>
  get(cmdId: string): Promise<EnvironmentControlEnvelope | null>
}
export interface EnvironmentControlPorts {
  store: EnvironmentControlStore
  envelopes: EnvironmentControlEnvelopes
}

export type EnvironmentActionStatus =
  | 'queued'
  | 'delivered'
  | 'completed'
  | 'refused'
  | 'failed'
  | 'expired'
  | 'rejected'
  | 'outcome-unknown'
export type EnvironmentActionOutcome =
  | 'pending'
  | 'accepted'
  | 'refused'
  | 'unsupported'
  | 'failed'
  | 'not-delivered'
  | 'unknown'

export interface EnvironmentActionView {
  id: string
  farmId: string
  printerId: string
  control: EnvironmentControlKind
  action: string
  args: Record<string, unknown>
  status: EnvironmentActionStatus
  outcome: EnvironmentActionOutcome
  refusal?: { code: ApiEnvelopeRefusalCode; detail?: string }
  managementUrl: string
  createdAt: number
  updatedAt: number
}

function statusOf(envelope: EnvironmentControlEnvelope | null) {
  switch (envelope?.status) {
    case undefined:
    case 'pending':
    case 'sending':
    case 'sent':
      return 'queued'
    case 'delivered':
    case 'started':
      return 'delivered'
    case 'completed':
      return 'completed'
    case 'refused':
      return 'refused'
    case 'failed':
    case 'cancelled':
      return 'failed'
    case 'expired':
      return 'expired'
    case 'rejected':
      return 'rejected'
    default:
      return 'outcome-unknown'
  }
}

const OUTCOME: Record<
  Exclude<EnvironmentActionStatus, 'refused'>,
  EnvironmentActionOutcome
> = {
  queued: 'pending',
  delivered: 'pending',
  completed: 'accepted',
  failed: 'failed',
  expired: 'not-delivered',
  rejected: 'not-delivered',
  'outcome-unknown': 'unknown',
}

export function environmentActionView(
  record: EnvironmentControlRecord,
  envelope: EnvironmentControlEnvelope | null,
): EnvironmentActionView {
  const status = statusOf(envelope)
  const request = environmentRequestOf(record.action)
  const refusal =
    status === 'refused' && envelope?.refusalCode
      ? {
          code: envelope.refusalCode,
          ...(envelope.resultDetail ? { detail: envelope.resultDetail } : {}),
        }
      : undefined
  return {
    id: record.id,
    farmId: record.farmId,
    printerId: record.printerAssignmentId,
    control: request.control,
    action: request.action,
    args: request.args as Record<string, unknown>,
    status,
    outcome:
      status === 'refused'
        ? refusal?.code === 'unsupported'
          ? 'unsupported'
          : 'refused'
        : OUTCOME[status],
    ...(refusal ? { refusal } : {}),
    managementUrl: environmentManagementUrl({
      farmId: record.farmId,
      printerKey: record.printerKey,
    }),
    createdAt: record.createdAt,
    updatedAt: Math.max(record.updatedAt, envelope?.updatedAt ?? 0),
  }
}

export type EnvironmentActionProblem =
  | 'not-found'
  | 'validation-failed'
  | 'unsupported'
  | 'device-stale'
  | 'device-not-ready'
  | 'idempotency-key-reused'
  | 'insufficient-scope'
  | 'service-unavailable'
export type SubmitEnvironmentActionResult =
  | { ok: true; created: boolean; action: EnvironmentActionView }
  | { ok: false; problem: EnvironmentActionProblem; managementUrl?: string }

export const ENVIRONMENT_ACTION_TTL_MS = 60_000

const KIND_OF: Record<ApiEnvironmentAction['action'], EnvironmentControlKind> =
  {
    extraction_set: 'extraction',
    plug_switch: 'plug',
    drying_start: 'drying',
    drying_stop: 'drying',
  }

export function environmentRequestHash(
  printerId: string,
  action: ApiEnvironmentAction,
) {
  return createHash('sha256')
    .update(JSON.stringify(['environment', printerId, action]))
    .digest('hex')
}

export interface EnvironmentControlDeps {
  readPrinter(printerId: string): Promise<IntegrationPrinterRow | null>
  /** Absent until the environment-control storage is configured. */
  ports: EnvironmentControlPorts | null
  now: () => number
  ttlMs?: number
}

/**
 * `POST /environment/controls/{printerId}/actions`. Order: grant (out of grant
 * is 404), readiness from the last observation (unsupported answers with the
 * management link, stale or not-ready refuse without a command), idempotency,
 * then exactly one signed envelope and one delivery attempt.
 */
export async function submitEnvironmentControlAction(
  principal: IntegrationPrincipal,
  printerId: string,
  key: string,
  body: unknown,
  deps: EnvironmentControlDeps,
): Promise<SubmitEnvironmentActionResult> {
  const printer = printerId.toLowerCase()
  if (!uuidPattern.test(printer)) return { ok: false, problem: 'not-found' }
  const parsed = parseEnvironmentControlRequest(body)
  if (!parsed) return { ok: false, problem: 'validation-failed' }
  if (!principal.scopes.includes('environment:control'))
    return { ok: false, problem: 'insufficient-scope' }
  const row = await deps.readPrinter(printer)
  if (!row || row.id.toLowerCase() !== printer)
    return { ok: false, problem: 'not-found' }
  const grant = integrationGrantFor(
    principal,
    'environment:control',
    row.farmId,
    row.id,
  )
  if (!grant) return { ok: false, problem: 'not-found' }
  const managementUrl = environmentManagementUrl(row)
  const requestHash = environmentRequestHash(row.id, parsed.action)
  const prior = await deps.ports?.store.existing(principal.appId, key)
  if (prior) {
    if (prior.record.requestHash !== requestHash)
      return { ok: false, problem: 'idempotency-key-reused' }
    return {
      ok: true,
      created: false,
      action: environmentActionView(prior.record, prior.envelope),
    }
  }
  const now = deps.now()
  const { readiness } = readinessOf(KIND_OF[parsed.action.action], row, now)
  if (readiness === 'unsupported')
    return { ok: false, problem: 'unsupported', managementUrl }
  // Owner approval of environment controls happens in OpenFarm itself.
  if (grant.requiresApproval)
    return { ok: false, problem: 'unsupported', managementUrl }
  if (readiness === 'stale')
    return { ok: false, problem: 'device-stale', managementUrl }
  if (readiness !== 'ready' || !row.agentId)
    return { ok: false, problem: 'device-not-ready', managementUrl }
  const ports = deps.ports
  if (!ports) return { ok: false, problem: 'service-unavailable' }
  const created = await ports.store.create({
    id: randomUUID(),
    appId: principal.appId,
    grantId: grant.id,
    farmId: row.farmId,
    printerAssignmentId: row.id,
    printerKey: row.printerKey,
    idempotencyKey: key,
    requestHash,
    action: parsed.action,
    createdAt: now,
    updatedAt: now,
  })
  const record = created.record
  if (created.kind === 'existing') {
    if (record.requestHash !== requestHash)
      return { ok: false, problem: 'idempotency-key-reused' }
    const stored = await ports.store.get(record.id, principal.appId)
    return {
      ok: true,
      created: false,
      action: environmentActionView(record, stored?.envelope ?? null),
    }
  }
  const issued = await ports.envelopes.issue({
    appId: record.appId,
    grantId: record.grantId,
    farmId: record.farmId,
    agentId: row.agentId,
    printerAssignmentId: record.printerAssignmentId,
    resourceId: record.id,
    ttlMs: deps.ttlMs ?? ENVIRONMENT_ACTION_TTL_MS,
    action: record.action,
  })
  if (!issued.ok)
    return {
      ok: false,
      problem:
        issued.reason === 'invalid'
          ? 'validation-failed'
          : 'insufficient-scope',
    }
  let envelope = issued.envelope
  if (issued.created) {
    try {
      await ports.envelopes.deliver(envelope.cmdId)
      envelope = (await ports.envelopes.get(envelope.cmdId)) ?? envelope
    } catch {
      /* A stored envelope is never resent after an uncertain write. */
    }
  }
  return {
    ok: true,
    created: true,
    action: environmentActionView(record, envelope),
  }
}

/** `GET /environment/controls/{printerId}/actions/{actionId}`: the real outcome, scoped to the app and its grants. */
export async function getEnvironmentControlAction(
  principal: IntegrationPrincipal,
  printerId: string,
  actionId: string,
  ports: EnvironmentControlPorts | null,
) {
  if (!uuidPattern.test(actionId) || !uuidPattern.test(printerId))
    return { error: 'not-found' as const }
  if (!ports) return { error: 'service-unavailable' as const }
  const result = await ports.store.get(actionId.toLowerCase(), principal.appId)
  if (
    !result ||
    result.record.appId !== principal.appId ||
    result.record.printerAssignmentId !== printerId.toLowerCase()
  )
    return { error: 'not-found' as const }
  if (
    !integrationGrantFor(
      principal,
      'environment:control',
      result.record.farmId,
      result.record.printerAssignmentId,
    )
  )
    return { error: 'not-found' as const }
  return environmentActionView(result.record, result.envelope)
}
