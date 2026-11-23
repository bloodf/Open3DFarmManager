import postgres from 'postgres'
import { PostgresFleetMode } from '../storage/fleet-mode-postgres.ts'
import { integrationAuthPool } from './integration-auth-runtime.ts'
import { useRuntimeConfig } from 'nuxt/server'
import { z } from 'zod'
import {
  IntegrationDeliveryService,
  type EnvelopeInbox,
} from '../services/integration-delivery.ts'
import { IntegrationAuditService } from '../services/integration-audit.ts'
import { IntegrationActionsService } from '../services/integration-actions.ts'
import { IntegrationApprovalService } from '../services/integration-approval.ts'
import {
  DEFAULT_JOB_ENVELOPE_TTL_MS,
  DEFAULT_MAX_JOB_BYTES,
  IntegrationJobsService,
} from '../services/integration-jobs.ts'
import { PostgresIntegrationAudit } from '../storage/integration-audit-postgres.ts'
import { PostgresIntegrationJobDelivery } from '../storage/integration-jobs-history.ts'
import { PostgresIntegrationJobs } from '../storage/integration-jobs-postgres.ts'
import { PostgresIntegrationActions } from '../storage/integration-actions-postgres.ts'
import { PostgresIntegrationApprovals } from '../storage/integration-approval-postgres.ts'
import { IntegrationLibraryService } from '../services/integration-library.ts'
import { PostgresIntegrationLibrary } from '../storage/integration-library-postgres.ts'

/** Until the Connector inbox registers itself, envelopes stay queued for `deliverPending`. */
const noInbox: EnvelopeInbox = { sendToAgentInbox: () => 'no-inbox' }
let inbox: EnvelopeInbox = noInbox

const integrationJobsConfig = z.object({
  enabled: z.literal(true),
  databaseUrl: z.unknown().optional(),
  envelopeSigningKey: z.unknown().optional(),
  envelopeKid: z.unknown().optional(),
  maxFileBytes: z.unknown().optional(),
  envelopeTtlMs: z.unknown().optional(),
})

/** The Connector inbox hook (E7.22): replaces the default that never delivers. */
export function setIntegrationEnvelopeInbox(next: EnvelopeInbox | null) {
  const previous = inbox
  inbox = next ?? noInbox
  const delivery = active?.delivery
  if (next && next !== previous && delivery) next.bindApiDelivery?.(delivery)
}

let active:
  | {
      pool: ReturnType<typeof postgres>
      service: IntegrationJobsService
      actions: IntegrationActionsService
      approvals: IntegrationApprovalService
      delivery: IntegrationDeliveryService | undefined
      library: IntegrationLibraryService
    }
  | undefined

function positive(value: unknown, fallback: number) {
  const number =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof number === 'number' &&
    Number.isSafeInteger(number) &&
    number > 0
    ? number
    : fallback
}

async function importSigningKey(encoded: string) {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(encoded))
    throw new Error('Configuração de envelopes de integrações inválida.')
  return await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(encoded, 'base64url'),
    'Ed25519',
    false,
    ['sign'],
  )
}

export async function integrationJobsRuntime() {
  if (active) return active
  const parsed = integrationJobsConfig.safeParse(
    useRuntimeConfig().integrationJobs,
  )
  if (!parsed.success)
    throw new Error('Envio de trabalhos de integrações indisponível.')
  const config = parsed.data
  if (typeof config.databaseUrl !== 'string')
    throw new Error('Configuração de trabalhos de integrações inválida.')
  const url = new URL(config.databaseUrl)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    url.pathname.length < 2
  )
    throw new Error('Configuração de trabalhos de integrações inválida.')
  const signer =
    typeof config.envelopeSigningKey === 'string' && config.envelopeSigningKey
      ? {
          kid: String(config.envelopeKid),
          signingKey: await importSigningKey(config.envelopeSigningKey),
        }
      : undefined
  // The login is a member of farm_integration_jobs, farm_integration_approvals and farm_integration_delivery.
  const pool = postgres(url.toString(), {
    max: 3,
    connect_timeout: 3,
    idle_timeout: 20,
    onnotice: () => {},
    connection: {
      statement_timeout: 2000,
      lock_timeout: 1000,
      search_path: 'pg_catalog',
    },
  })
  const deliveryStore = new PostgresIntegrationJobDelivery(pool)
  const delivery = signer
    ? new IntegrationDeliveryService({
        store: deliveryStore,
        inbox: {
          sendToAgentInbox: (...args) => inbox.sendToAgentInbox(...args),
          bindApiDelivery: (delivery) => inbox.bindApiDelivery?.(delivery),
        },
        audit: new IntegrationAuditService(new PostgresIntegrationAudit(pool)),
        signer,
      })
    : undefined
  const libraryStore = new PostgresIntegrationLibrary(pool)
  const library = new IntegrationLibraryService(libraryStore)
  const service = new IntegrationJobsService({
    store: new PostgresIntegrationJobs(pool),
    fleetMode: async (id) =>
      (await new PostgresFleetMode(integrationAuthPool()).read(id))?.mode ??
      'in-service',
    library: {
      version: (id) => library.version(id),
      recordReplay: (entry) => library.recordReplay(entry),
    },
    ...(delivery
      ? {
          envelopes: {
            issue: (input) => delivery.issue(input),
            deliver: (cmdId) => delivery.deliver(cmdId),
            get: (cmdId) => deliveryStore.get(cmdId),
          },
        }
      : {}),
    maxFileBytes: positive(config.maxFileBytes, DEFAULT_MAX_JOB_BYTES),
    envelopeTtlMs: positive(config.envelopeTtlMs, DEFAULT_JOB_ENVELOPE_TTL_MS),
  })
  const actions = new IntegrationActionsService({
    store: new PostgresIntegrationActions(pool),
    ...(delivery
      ? {
          envelopes: {
            issue: (input) => delivery.issue(input),
            deliver: (cmdId) => delivery.deliver(cmdId),
            get: (cmdId) => deliveryStore.get(cmdId),
          },
        }
      : {}),
    ttlMs: positive(config.envelopeTtlMs, DEFAULT_JOB_ENVELOPE_TTL_MS),
  })
  const approvals = new IntegrationApprovalService({
    store: new PostgresIntegrationApprovals(pool),
    ...(delivery
      ? {
          envelopes: {
            issue: (input) => delivery.issue(input),
            deliver: (cmdId) => delivery.deliver(cmdId),
            get: (cmdId) => deliveryStore.get(cmdId),
          },
        }
      : {}),
    envelopeTtlMs: positive(config.envelopeTtlMs, DEFAULT_JOB_ENVELOPE_TTL_MS),
  })
  active = { pool, service, actions, approvals, delivery, library }
  return active
}

export async function integrationLibraryRuntime() {
  const runtime = await integrationJobsRuntime()
  return { service: runtime.library }
}

export async function closeIntegrationJobsRuntime() {
  const closing = active
  active = undefined
  await closing?.pool.end({ timeout: 3 })
}
