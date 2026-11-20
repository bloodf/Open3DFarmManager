import postgres, { type Sql } from 'postgres'
import { createLogger } from '@open3dfarmmanager/shared'
import { createError, useRuntimeConfig, type RequestEvent } from 'nuxt/server'
import { isBambuCloudEnabled } from '../../../../../packages/connector/src/bambu/cloud.ts'
import {
  authenticatedSession,
  authResponse,
  sealedSessionRecordId,
} from '../../services/authenticated-session.ts'
import { authRuntime } from '../auth/runtime.ts'
import {
  BAMBU_FARM_ID,
  type BambuCloudAccountStore,
  type BambuCloudFailure,
} from './account.ts'
import { bambuCloudDatabaseStore } from './postgres.ts'
import { postgresBambuCloudImportCredentials } from './import-printers-http.ts'
import {
  fetchBambuCloudHistory,
  type BambuCloudHistoryTask,
} from './import-history.ts'

const logger = createLogger('bambu-cloud-history')
let sqlClient: Sql | undefined

export interface BambuCloudHistoryPersistence {
  assignment(
    farmId: string,
    serial: string,
  ): Promise<{ agentId: string; printerKey: string } | null>
  upsert(
    farmId: string,
    assignment: { agentId: string; printerKey: string },
    task: BambuCloudHistoryTask,
  ): Promise<'inserted' | 'updated'>
}

export class PostgresBambuCloudHistoryPersistence implements BambuCloudHistoryPersistence {
  constructor(private readonly sql: Sql) {}

  async assignment(farmId: string, serial: string) {
    const rows = await this.sql<{ agentId: string; printerKey: string }[]>`
      SELECT agent_id::text AS "agentId", printer_key AS "printerKey"
      FROM farm.printer_assignments
      WHERE farm_id = ${farmId}::uuid AND revoked_at IS NULL AND printer_key = ${serial}`
    return rows[0] ?? null
  }

  async upsert(
    farmId: string,
    assignment: { agentId: string; printerKey: string },
    task: BambuCloudHistoryTask,
  ) {
    const duration =
      task.startedAt === null
        ? null
        : Math.max(0, (task.endedAt - task.startedAt) / 1000)
    const rows = await this.sql<{ inserted: boolean }[]>`
      INSERT INTO farm.job_history
        (farm_id, agent_id, printer_key, outcome, filename, print_duration_seconds,
         total_duration_seconds, filament_usage, ended_at, bambu_cloud_task_id, total_filament_grams)
      VALUES (${farmId}::uuid, ${assignment.agentId}::uuid, ${assignment.printerKey},
        ${task.outcome}, ${task.title}, ${duration}, ${duration},
        ${JSON.stringify(task.filamentUsage)}::jsonb, ${task.endedAt}, ${task.id}, ${task.totalGrams})
      ON CONFLICT (farm_id, printer_key, bambu_cloud_task_id) WHERE bambu_cloud_task_id IS NOT NULL
      DO UPDATE SET outcome = EXCLUDED.outcome, filename = EXCLUDED.filename,
        print_duration_seconds = EXCLUDED.print_duration_seconds,
        total_duration_seconds = EXCLUDED.total_duration_seconds,
        filament_usage = EXCLUDED.filament_usage, ended_at = EXCLUDED.ended_at,
        total_filament_grams = EXCLUDED.total_filament_grams
      RETURNING (xmax = 0) AS inserted`
    return rows[0]?.inserted ? ('inserted' as const) : ('updated' as const)
  }
}
function databaseUrl(): string {
  const value = process.env.OPENFARM_BAMBU_CLOUD_DATABASE_URL
  if (!value || value.length > 2048)
    throw createError({ status: 503, message: 'Histórico indisponível.' })
  return value
}
function masterKey(): string {
  const auth = useRuntimeConfig().auth
  if (
    typeof auth !== 'object' ||
    auth === null ||
    !('sessionSecret' in auth) ||
    typeof auth.sessionSecret !== 'string' ||
    auth.sessionSecret.length < 32
  ) {
    throw createError({ status: 503, message: 'Histórico indisponível.' })
  }
  return auth.sessionSecret
}
function db(url: string): Sql {
  if (!sqlClient)
    sqlClient = postgres(url, {
      max: 2,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: { statement_timeout: 5000, lock_timeout: 1000 },
    })
  return sqlClient
}
function failure(reason: BambuCloudFailure): never {
  if (reason === 'forbidden')
    throw createError({
      status: 403,
      message: 'Apenas o proprietário pode importar o histórico Bambu Cloud.',
    })
  if (reason === 'not-found' || reason === 'cloud-disabled')
    throw createError({
      status: 404,
      message: 'Conta Bambu Cloud indisponível.',
    })
  if (reason === 'cloud-unauthorized' || reason === 'cloud-rejected')
    throw createError({
      status: 422,
      message: 'Não foi possível importar o histórico da nuvem Bambu.',
    })
  if (reason === 'invalid-input')
    throw createError({ status: 400, message: 'Solicitação inválida.' })
  throw createError({
    status: 503,
    message: 'Histórico indisponível. Tente novamente.',
  })
}

export async function importBambuCloudHistory(input: {
  farmId: string
  credentials: ReturnType<typeof postgresBambuCloudImportCredentials>
  policy: unknown
  fetchImpl?: typeof fetch
  persistence: BambuCloudHistoryPersistence
}): Promise<{ imported: number; updated: number; skipped: number }> {
  if (!BAMBU_FARM_ID.test(input.farmId))
    throw createError({ status: 400, message: 'Solicitação inválida.' })
  const loaded = await input.credentials.load(input.farmId)
  if (!loaded.ok) failure(loaded.reason)
  const cloud = await fetchBambuCloudHistory({
    ...loaded.credentials,
    policy: input.policy,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  })
  if (!cloud.ok) failure(cloud.reason)
  let imported = 0
  let updated = 0
  let unmatched = 0
  for (const task of cloud.tasks) {
    const assignment = await input.persistence.assignment(
      input.farmId,
      task.serial,
    )
    if (!assignment) {
      unmatched += 1
      continue
    }
    const result = await input.persistence.upsert(
      input.farmId,
      assignment,
      task,
    )
    if (result === 'inserted') imported += 1
    else updated += 1
  }
  logger.info('bambu cloud history imported', {
    farmId: input.farmId,
    imported,
    updated,
    skipped: cloud.skipped + unmatched,
  })
  return { imported, updated, skipped: cloud.skipped + unmatched }
}

export async function bambuCloudHistoryHttp(
  event: RequestEvent,
  target: { farmId: string },
  overrides?: { store?: BambuCloudAccountStore; fetchImpl?: typeof fetch },
) {
  authResponse(event)
  event.res.headers.set('Cache-Control', 'no-store')
  if (!isBambuCloudEnabled(useRuntimeConfig()))
    throw createError({ status: 404, message: 'Histórico indisponível.' })
  if (
    !BAMBU_FARM_ID.test(target.farmId) ||
    event.req.method !== 'POST' ||
    (event.req.headers.get('content-length') !== null &&
      event.req.headers.get('content-length') !== '0')
  )
    throw createError({ status: 400, message: 'Solicitação inválida.' })
  const auth = authRuntime()
  const { accountId } = await authenticatedSession(event, auth)
  const sessionId = await sealedSessionRecordId(event, auth)
  try {
    if (
      !(await auth.credentials.consumeLimit(
        's',
        `bambu-cloud:history:${sessionId}`,
      ))
    )
      throw createError({
        status: 429,
        message: 'Muitas tentativas. Aguarde antes de tentar novamente.',
      })
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    return failure('storage-unavailable')
  }
  let ownerStore = overrides?.store
  let connection: Sql
  let credentials: ReturnType<typeof postgresBambuCloudImportCredentials>
  try {
    const secret = masterKey()
    const url = databaseUrl()
    connection = db(url)
    ownerStore = ownerStore ?? bambuCloudDatabaseStore(url, secret)
    credentials = postgresBambuCloudImportCredentials(
      url,
      secret,
      process.env.OPENFARM_BAMBU_CLOUD_ORIGIN,
    )
  } catch {
    return failure('storage-unavailable')
  }
  if (
    (await ownerStore.member({ farmId: target.farmId, accountId })) !== 'owner'
  )
    return failure('forbidden')
  return importBambuCloudHistory({
    farmId: target.farmId,
    credentials,
    policy: useRuntimeConfig(),
    persistence: new PostgresBambuCloudHistoryPersistence(connection),
    ...(overrides?.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  })
}
