import postgres from 'postgres'
import { useRuntimeConfig } from 'nuxt/server'
import {
  IntegrationDeliveryService,
  type EnvelopeInbox,
} from '../services/integration-delivery.ts'
import { IntegrationAuditService } from '../services/integration-audit.ts'
import {
  DEFAULT_JOB_ENVELOPE_TTL_MS,
  DEFAULT_MAX_JOB_BYTES,
  IntegrationJobsService,
} from '../services/integration-jobs.ts'
import { PostgresIntegrationAudit } from '../storage/integration-audit-postgres.ts'
import { PostgresIntegrationDelivery } from '../storage/integration-delivery-postgres.ts'
import { PostgresIntegrationJobs } from '../storage/integration-jobs-postgres.ts'

/** Until the Connector inbox registers itself, envelopes stay queued for `deliverPending`. */
const noInbox: EnvelopeInbox = { sendToAgentInbox: () => 'no-inbox' }
let inbox: EnvelopeInbox = noInbox

/** The Connector inbox hook (E7.22): replaces the default that never delivers. */
export function setIntegrationEnvelopeInbox(next: EnvelopeInbox | null) {
  inbox = next ?? noInbox
}

let active:
  | {
      pool: ReturnType<typeof postgres>
      service: IntegrationJobsService
      delivery: IntegrationDeliveryService | undefined
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
  const config = useRuntimeConfig().integrationJobs
  if (config.enabled !== true)
    throw new Error('Envio de trabalhos de integrações indisponível.')
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
  // The login is a member of farm_integration_jobs and farm_integration_delivery.
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
  const deliveryStore = new PostgresIntegrationDelivery(pool)
  const delivery = signer
    ? new IntegrationDeliveryService({
        store: deliveryStore,
        inbox: {
          sendToAgentInbox: (...args) => inbox.sendToAgentInbox(...args),
        },
        audit: new IntegrationAuditService(new PostgresIntegrationAudit(pool)),
        signer,
      })
    : undefined
  const service = new IntegrationJobsService({
    store: new PostgresIntegrationJobs(pool),
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
  active = { pool, service, delivery }
  return active
}

export async function closeIntegrationJobsRuntime() {
  const closing = active
  active = undefined
  await closing?.pool.end({ timeout: 3 })
}
