import { validateResinArtifactContract } from '../../../../packages/shared/src/print-file/resin-artifacts.ts'
import { createHash, randomUUID } from 'node:crypto'
import {
  ApiEnvelopeAction,
  ApiEnvelopeJob,
  ApiResinReplay,
} from '../../../../packages/farm-protocol/src/api-envelope.ts'
import {
  libraryJobFileUrl,
  type ResolvedLibraryVersion,
  type StorageMode,
} from './integration-library.ts'
import type {
  DeliveryResult,
  EnvelopeRecord,
  EnvelopeStatus,
  IssueEnvelope,
  IssueResult,
} from './integration-delivery.ts'
import { integrationGrantFor } from '../utils/integration-auth-http.ts'
import {
  uuidPattern,
  type IntegrationPrincipal,
} from '../utils/integration-auth.ts'

/**
 * `POST /printers/{id}/jobs`: stores a job and hands it to the delivery path,
 * or holds it when the grant requires operator approval. The job is a file
 * reference only (HTTPS URL, SHA-256, size): the server never downloads or
 * stores the file, and the Connector alone decides whether to start it.
 */
export const DEFAULT_MAX_JOB_BYTES = 16 * 1024 ** 3
export const DEFAULT_JOB_ENVELOPE_TTL_MS = 300_000
/** Room for the rest of the signed envelope inside the protocol's wire limit. */
const MAX_JOB_FIELDS_BYTES = 3000
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

/** A held item no operator decided within this window expires and is never delivered. */
export const HELD_TTL_MS = 86_400_000
export type StoredJobStatus = 'held' | 'submitted' | 'rejected' | 'expired'
/** `queued` is a submitted job whose envelope the Connector has not yet confirmed. */
export type JobStatus =
  | 'held'
  | 'rejected'
  | 'queued'
  | 'expired'
  | 'delivered'
  | 'refused'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'outcome-unknown'

export interface JobFile {
  fileUrl: string
  sha256: string
  sizeBytes: number
  displayName: string
  libraryVersionId?: string
  plate?: number
  storageMode?: StorageMode
  resinProfile?: string
}
export interface NewJob extends JobFile {
  id: string
  appId: string
  grantId: string
  farmId: string
  printerAssignmentId: string
  idempotencyKey: string
  requestHash: string
  status: 'held' | 'submitted'
}
export interface JobRecord extends Omit<NewJob, 'status'> {
  status: StoredJobStatus
  createdAt: number
  updatedAt: number
}
export interface JobTarget {
  farmId: string
  agentId: string
}
export type CreateJobOutcome =
  | { kind: 'created'; record: JobRecord }
  /** `cmdId` is the job's envelope, or `null` when none was issued yet. */
  | { kind: 'existing'; record: JobRecord; cmdId: string | null }
  /** The grant, scope, assignment or sandbox rule no longer allows the job. */
  | { kind: 'refused' }
export interface IntegrationJobsStore {
  /** The active printer's farm and Connector agent. */
  target(printerAssignmentId: string): Promise<JobTarget | null>
  /**
   * Stores the job and its `job.submitted` audit entry in one transaction.
   * A retry of (app, key) returns the stored job and writes nothing.
   */
  create(job: NewJob, now: number): Promise<CreateJobOutcome>
  get(
    id: string,
    appId: string,
  ): Promise<{ record: JobRecord; envelope: EnvelopeRecord | null } | null>
}
export interface JobEnvelopes {
  issue(input: IssueEnvelope): Promise<IssueResult>
  deliver(cmdId: string): Promise<DeliveryResult>
  get(cmdId: string): Promise<EnvelopeRecord | null>
}

export type JobProblem =
  | 'validation-failed'
  | 'insufficient-scope'
  | 'not-found'
  | 'idempotency-key-reused'
  | 'service-unavailable'

export interface JobView {
  id: string
  farmId: string
  printerId: string
  status: JobStatus
  refusal?: { code: string; detail?: string; message?: string }
  displayName: string
  fileUrl: string
  sha256: string
  sizeBytes: number
  libraryVersionId?: string
  plate?: number
  storageMode?: StorageMode
  resinProfile?: string
  historyEntryId?: string
  createdAt: number
  updatedAt: number
}
export type SubmitJobResult =
  | { ok: true; created: boolean; job: JobView }
  | {
      ok: false
      problem: JobProblem
      reason?: { pointer: string; detail: string }
    }

const PENDING_DELIVERY: readonly EnvelopeStatus[] = [
  'pending',
  'sending',
  'sent',
]

/** The job status an API client sees: the stored decision, then the envelope's state. */
export function jobStatusOf(
  stored: StoredJobStatus,
  envelope: EnvelopeRecord | null,
  heldExpired = false,
): JobStatus {
  if (stored === 'held' && heldExpired) return 'expired'
  if (stored !== 'submitted') return stored
  if (!envelope || PENDING_DELIVERY.includes(envelope.status)) return 'queued'
  // A rejected envelope lost its authority before delivery: the job never ran.
  return envelope.status === 'rejected'
    ? 'expired'
    : (envelope.status as JobStatus)
}

export function jobView(
  record: JobRecord,
  envelope: EnvelopeRecord | null,
  now?: number,
): JobView {
  const view: JobView = {
    id: record.id,
    farmId: record.farmId,
    printerId: record.printerAssignmentId,
    status: jobStatusOf(
      record.status,
      envelope,
      now !== undefined && now >= record.createdAt + HELD_TTL_MS,
    ),
    displayName: record.displayName,
    fileUrl: record.fileUrl,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes,
    ...(record.libraryVersionId
      ? { libraryVersionId: record.libraryVersionId }
      : {}),
    ...(record.plate !== undefined ? { plate: record.plate } : {}),
    ...(record.storageMode ? { storageMode: record.storageMode } : {}),
    ...(record.resinProfile ? { resinProfile: record.resinProfile } : {}),
    createdAt: record.createdAt,
    updatedAt: Math.max(record.updatedAt, envelope?.updatedAt ?? 0),
  }
  if (record.status === 'submitted' && envelope) {
    if (envelope.refusalCode)
      view.refusal = {
        code: envelope.refusalCode,
        ...(envelope.resultDetail ? { detail: envelope.resultDetail } : {}),
        ...(envelope.resultMessage ? { message: envelope.resultMessage } : {}),
      }
    if (envelope.historyEntryId) view.historyEntryId = envelope.historyEntryId
  }
  return view
}

export function parseJobRequest(
  body: unknown,
  maxBytes = DEFAULT_MAX_JOB_BYTES,
): JobFile | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const keys = Object.keys(body)
  const allowed = ['fileUrl', 'sha256', 'sizeBytes', 'displayName']
  if (keys.length !== allowed.length || keys.some((k) => !allowed.includes(k)))
    return null
  const input = body as Record<string, unknown>
  const parsed = ApiEnvelopeJob.safeParse({
    file_url: input.fileUrl,
    sha256: input.sha256,
    size_bytes: input.sizeBytes,
    display_name: input.displayName,
  })
  if (!parsed.success || parsed.data.size_bytes > maxBytes) return null
  const job = parsed.data
  if (Buffer.byteLength(JSON.stringify(job)) > MAX_JOB_FIELDS_BYTES) return null
  return {
    fileUrl: job.file_url,
    sha256: job.sha256,
    sizeBytes: job.size_bytes,
    displayName: job.display_name,
  }
}

/** A library replay: `libraryVersionId` (or `library_version_id`) and optional `plate`. */
export function parseLibraryJobRequest(
  body: unknown,
): { libraryVersionId: string; plate?: number } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const input = body as Record<string, unknown>
  const keys = Object.keys(input)
  const allowed = ['libraryVersionId', 'library_version_id', 'plate']
  if (
    keys.length === 0 ||
    keys.some((key) => !allowed.includes(key)) ||
    keys.includes('libraryVersionId') === keys.includes('library_version_id')
  )
    return null
  const id = input.libraryVersionId ?? input.library_version_id
  if (typeof id !== 'string' || !uuidPattern.test(id.toLowerCase())) return null
  if (!('plate' in input)) return { libraryVersionId: id.toLowerCase() }
  if (
    typeof input.plate !== 'number' ||
    !Number.isInteger(input.plate) ||
    input.plate < 1 ||
    input.plate > 1000
  )
    return null
  return { libraryVersionId: id.toLowerCase(), plate: input.plate }
}

/** What starts a library version: the Connector fetches it by hash only. */
export function libraryReplayAction(file: { sha256: string; plate?: number }) {
  return ApiEnvelopeAction.parse({
    action: 'start_library_print',
    args: {
      sha256: file.sha256,
      ...(file.plate !== undefined ? { plate: file.plate } : {}),
    },
  })
}

export function resinReplayAction(file: JobFile) {
  return ApiResinReplay.parse({
    action: 'start_library_print',
    args: {
      sha256: file.sha256,
      versionId: file.libraryVersionId,
      filename: file.displayName,
      profile: file.resinProfile,
      plate: file.plate,
    },
  })
}

export function jobRequestHash(printerId: string, file: JobFile) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        file.libraryVersionId
          ? [
              printerId,
              file.fileUrl,
              file.sha256,
              file.sizeBytes,
              file.displayName,
              file.libraryVersionId,
              file.plate ?? null,
              file.storageMode ?? null,
            ]
          : [
              printerId,
              file.fileUrl,
              file.sha256,
              file.sizeBytes,
              file.displayName,
            ],
      ),
    )
    .digest('hex')
}

export type IntegrationJobsOptions = Readonly<{
  store: IntegrationJobsStore
  /** Resolves a library version for `libraryVersionId` replays. */
  library?: {
    version(id: string): Promise<ResolvedLibraryVersion | null>
    recordReplay(entry: {
      farmId: string
      appId: string
      printerId: string
      versionId: string
      storageMode: StorageMode
      plate?: number
      outcome: 'accepted' | 'held'
    }): Promise<void>
  }
  /** Read current operational availability before accepting a job. */
  fleetMode?: (printerId: string) => Promise<'in-service' | 'maintenance'>
  /** Absent when no envelope signer is configured: only held jobs can be accepted. */
  envelopes?: JobEnvelopes
  maxFileBytes?: number
  envelopeTtlMs?: number
  now?: () => number
  /** Failures never carry job contents. Defaults to silent. */
  onError?: (site: 'deliver') => void
}>

export class IntegrationJobsService {
  private readonly o: IntegrationJobsOptions
  private readonly now: () => number
  constructor(options: IntegrationJobsOptions) {
    this.o = options
    this.now = options.now ?? Date.now
  }

  get maxFileBytes() {
    return this.o.maxFileBytes ?? DEFAULT_MAX_JOB_BYTES
  }

  async actionTarget(principal: IntegrationPrincipal, jobId: string) {
    if (!uuidPattern.test(jobId)) return null
    const result = await this.o.store.get(jobId, principal.appId)
    if (!result) return null
    const { record, envelope } = result
    return {
      id: record.id,
      farmId: record.farmId,
      printerId: record.printerAssignmentId,
      runId: envelope?.cmdId,
    }
  }

  async get(principal: IntegrationPrincipal, jobId: string) {
    if (!uuidPattern.test(jobId)) return { error: 'not-found' as const }
    const result = await this.o.store.get(jobId, principal.appId)
    if (!result) return { error: 'not-found' as const }
    if (
      !principal.scopes.includes('jobs:read') &&
      !principal.scopes.includes('jobs:start')
    ) {
      return { error: 'insufficient-scope' as const }
    }
    if (
      !integrationGrantFor(
        principal,
        'jobs:read',
        result.record.farmId,
        result.record.printerAssignmentId,
      ) &&
      !integrationGrantFor(
        principal,
        'jobs:start',
        result.record.farmId,
        result.record.printerAssignmentId,
      )
    ) {
      return { error: 'not-found' as const }
    }
    return jobView(result.record, result.envelope, this.now())
  }

  /**
   * `principal` comes from the authorizing middleware; the grant that covers
   * this printer decides whether the job is held. A retry with the same key
   * and request returns the original job, whatever has happened to it since.
   */
  async submit(
    principal: IntegrationPrincipal,
    printerId: string,
    idempotencyKey: string,
    body: unknown,
  ): Promise<SubmitJobResult> {
    const printer = printerId.toLowerCase()
    if (!uuidPattern.test(printer)) return { ok: false, problem: 'not-found' }
    if (!principal.scopes.includes('jobs:start'))
      return { ok: false, problem: 'insufficient-scope' }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))
      return { ok: false, problem: 'validation-failed' }
    const libraryRequest = parseLibraryJobRequest(body)
    const parsed = libraryRequest
      ? null
      : parseJobRequest(body, this.maxFileBytes)
    if (!libraryRequest && !parsed)
      return { ok: false, problem: 'validation-failed' }
    if (libraryRequest && !principal.scopes.includes('jobs:write'))
      return { ok: false, problem: 'insufficient-scope' }

    const target = await this.o.store.target(printer)
    const grant = target
      ? libraryRequest
        ? (principal.grants
            .filter(
              (candidate) =>
                candidate.scopes.includes('jobs:start') &&
                candidate.scopes.includes('jobs:write') &&
                candidate.farmId === target.farmId &&
                (candidate.printerAssignmentId === null ||
                  candidate.printerAssignmentId === printer),
            )
            .find((candidate) => !candidate.requiresApproval) ??
          principal.grants.find(
            (candidate) =>
              candidate.scopes.includes('jobs:start') &&
              candidate.scopes.includes('jobs:write') &&
              candidate.farmId === target.farmId &&
              (candidate.printerAssignmentId === null ||
                candidate.printerAssignmentId === printer),
          ))
        : integrationGrantFor(principal, 'jobs:start', target.farmId, printer)
      : undefined
    if (!target) return { ok: false, problem: 'not-found' }
    if (!grant)
      return {
        ok: false,
        problem: libraryRequest ? 'insufficient-scope' : 'not-found',
      }

    if ((await this.o.fleetMode?.(printer)) === 'maintenance')
      return {
        ok: false,
        problem: 'validation-failed',
        reason: { pointer: '/printerId', detail: 'maintenance' },
      }

    let file = parsed
    if (libraryRequest) {
      let resolved: ResolvedLibraryVersion | null
      try {
        resolved =
          (await this.o.library?.version(libraryRequest.libraryVersionId)) ??
          null
      } catch {
        return { ok: false, problem: 'service-unavailable' }
      }
      if (!this.o.library) return { ok: false, problem: 'service-unavailable' }
      if (
        !resolved ||
        resolved.id !== libraryRequest.libraryVersionId ||
        resolved.farmId !== target.farmId
      )
        return { ok: false, problem: 'not-found' }
      if (resolved.resinProfile !== undefined) {
        const contract = validateResinArtifactContract(
          resolved.displayName,
          resolved.resinProfile,
          libraryRequest.plate,
        )
        if (!contract.ok)
          return {
            ok: false,
            problem: 'validation-failed',
            reason: {
              pointer:
                contract.reason === 'plate-mismatch'
                  ? '/plate'
                  : '/libraryVersionId',
              detail: contract.reason,
            },
          }
      }
      if (
        libraryRequest.plate !== undefined &&
        libraryRequest.plate > resolved.plateCount
      )
        return { ok: false, problem: 'validation-failed' }
      file = {
        fileUrl: libraryJobFileUrl(resolved.id),
        sha256: resolved.sha256,
        sizeBytes: resolved.sizeBytes,
        displayName: resolved.displayName,
        libraryVersionId: resolved.id,
        storageMode: resolved.storageMode,
        ...(resolved.resinProfile !== undefined
          ? { resinProfile: resolved.resinProfile, plate: 1 }
          : libraryRequest.plate !== undefined
            ? { plate: libraryRequest.plate }
            : {}),
      }
    }
    if (!file) return { ok: false, problem: 'validation-failed' }
    // Never store a job that cannot be delivered.
    if (!grant.requiresApproval && !this.o.envelopes)
      return { ok: false, problem: 'service-unavailable' }

    const outcome = await this.o.store.create(
      {
        id: randomUUID(),
        appId: principal.appId,
        grantId: grant.id,
        farmId: target.farmId,
        printerAssignmentId: printer,
        idempotencyKey,
        requestHash: jobRequestHash(printer, file),
        ...file,
        status: grant.requiresApproval ? 'held' : 'submitted',
      },
      this.now(),
    )
    if (outcome.kind === 'refused')
      return { ok: false, problem: 'insufficient-scope' }
    const created = outcome.kind === 'created'
    const record = outcome.record
    if (!created && record.requestHash !== jobRequestHash(printer, file))
      return { ok: false, problem: 'idempotency-key-reused' }
    if (libraryRequest)
      await this.o.library?.recordReplay({
        farmId: record.farmId,
        appId: record.appId,
        printerId: printer,
        versionId: libraryRequest.libraryVersionId,
        storageMode: file.storageMode ?? 'connector',
        ...(file.plate !== undefined ? { plate: file.plate } : {}),
        outcome: record.status === 'held' ? 'held' : 'accepted',
      })
    if (record.status !== 'submitted')
      return { ok: true, created, job: jobView(record, null) }

    const envelopes = this.o.envelopes
    if (!envelopes) {
      // A replay needs no signer: report what is stored.
      return { ok: true, created, job: jobView(record, null) }
    }
    let envelope: EnvelopeRecord | null = null
    let deliver = false
    if (!created && outcome.cmdId) {
      envelope = await envelopes.get(outcome.cmdId)
    } else {
      // New job, or a retry of a job whose envelope was never issued.
      const issued = await envelopes.issue({
        appId: record.appId,
        grantId: record.grantId,
        farmId: record.farmId,
        agentId: target.agentId,
        printerAssignmentId: record.printerAssignmentId,
        resourceId: record.id,
        ttlMs: this.o.envelopeTtlMs ?? DEFAULT_JOB_ENVELOPE_TTL_MS,
        command:
          record.resinProfile !== undefined
            ? { kind: 'action', action: resinReplayAction(record) }
            : libraryRequest
              ? {
                  kind: 'action',
                  action: libraryReplayAction({
                    sha256: record.sha256,
                    ...(file.plate !== undefined ? { plate: file.plate } : {}),
                  }),
                }
              : {
                  kind: 'job',
                  job: {
                    file_url: record.fileUrl,
                    sha256: record.sha256,
                    size_bytes: record.sizeBytes,
                    display_name: record.displayName,
                  },
                },
      })
      if (!issued.ok)
        return {
          ok: false,
          problem:
            issued.reason === 'invalid'
              ? 'validation-failed'
              : 'insufficient-scope',
        }
      envelope = issued.record
      deliver = issued.created
    }
    if (deliver && envelope) {
      // The envelope is stored either way: a missing inbox only leaves it queued.
      try {
        await envelopes.deliver(envelope.cmdId)
        envelope = (await envelopes.get(envelope.cmdId)) ?? envelope
      } catch {
        try {
          this.o.onError?.('deliver')
        } catch {}
      }
    }
    return { ok: true, created, job: jobView(record, envelope) }
  }
}
