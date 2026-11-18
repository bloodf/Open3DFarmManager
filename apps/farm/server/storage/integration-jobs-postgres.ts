import type { Sql } from 'postgres'
import type {
  CreateJobOutcome,
  IntegrationJobsStore,
  JobRecord,
  JobTarget,
  NewJob,
} from '../services/integration-jobs.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0

const columns = (sql: Sql) =>
  sql`j.id::text AS "id", j.app_id::text AS "appId", j.grant_id::text AS "grantId", j.farm_id::text AS "farmId", j.printer_assignment_id::text AS "printerAssignmentId", j.idempotency_key AS "idempotencyKey", j.request_hash AS "requestHash", j.file_url AS "fileUrl", j.sha256, j.size_bytes::float8 AS "sizeBytes", j.display_name AS "displayName", j.status, j.created_at::float8 AS "createdAt", j.updated_at::float8 AS "updatedAt"`
const returning = (sql: Sql) =>
  sql`id::text AS "id", app_id::text AS "appId", grant_id::text AS "grantId", farm_id::text AS "farmId", printer_assignment_id::text AS "printerAssignmentId", idempotency_key AS "idempotencyKey", request_hash AS "requestHash", file_url AS "fileUrl", sha256, size_bytes::float8 AS "sizeBytes", display_name AS "displayName", status, created_at::float8 AS "createdAt", updated_at::float8 AS "updatedAt"`

/** The farm_integration_jobs role is the least-privilege caller. */
export class PostgresIntegrationJobs implements IntegrationJobsStore {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }
  async target(printerAssignmentId: string): Promise<JobTarget | null> {
    if (!uuid.test(printerAssignmentId)) return null
    const rows = await this.sql<JobTarget[]>`
      SELECT farm_id::text AS "farmId", agent_id::text AS "agentId"
      FROM farm.printer_assignments
      WHERE id = ${printerAssignmentId}::uuid AND revoked_at IS NULL`
    return rows[0] ? { ...rows[0] } : null
  }
  async create(job: NewJob, now: number): Promise<CreateJobOutcome> {
    if (!validTime(now)) throw new Error('Invalid time')
    try {
      return await this.sql.begin(async (tx): Promise<CreateJobOutcome> => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const rows = await tx<JobRecord[]>`
          INSERT INTO farm.integration_jobs (id, app_id, grant_id, farm_id, printer_assignment_id, idempotency_key, request_hash, file_url, sha256, size_bytes, display_name, status, created_at, updated_at)
          VALUES (${job.id}::uuid, ${job.appId}::uuid, ${job.grantId}::uuid, ${job.farmId}::uuid, ${job.printerAssignmentId}::uuid, ${job.idempotencyKey}, ${job.requestHash}, ${job.fileUrl}, ${job.sha256}, ${job.sizeBytes}, ${job.displayName}, ${job.status}, ${now}, ${now})
          ON CONFLICT (app_id, idempotency_key) DO NOTHING
          RETURNING ${returning(tx as unknown as Sql)}`
        if (rows[0]) {
          const record = { ...rows[0] }
          await tx`
            INSERT INTO farm.integration_audit (farm_id, app_id, printer_assignment_id, actor_kind, actor_id, action, resource_type, resource_id, outcome, occurred_at, details)
            VALUES (${record.farmId}::uuid, ${record.appId}::uuid, ${record.printerAssignmentId}::uuid, 'app', ${record.appId}, 'job.submitted', 'job', ${record.id}, ${record.status === 'held' ? 'held' : 'accepted'}, ${now}, ${tx.json({ status: record.status })})`
          return { kind: 'created', record }
        }
        const existing = await tx<(JobRecord & { cmdId: string | null })[]>`
          SELECT ${columns(tx as unknown as Sql)},
            (SELECT e.cmd_id::text FROM farm.integration_envelopes e WHERE e.kind = 'job' AND e.resource_id = j.id) AS "cmdId"
          FROM farm.integration_jobs j
          WHERE j.app_id = ${job.appId}::uuid AND j.idempotency_key = ${job.idempotencyKey}`
        if (!existing[0]) return { kind: 'refused' }
        const { cmdId, ...record } = existing[0]
        return { kind: 'existing', record, cmdId }
      })
    } catch (cause) {
      // A guard trigger or constraint refused it: grant, scope, assignment, sandbox or bounds.
      const code = (cause as { code?: string }).code
      if (code === 'P0001' || code === '23514') return { kind: 'refused' }
      throw cause
    }
  }
}
