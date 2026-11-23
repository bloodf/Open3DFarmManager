import type { Sql } from 'postgres'
import type {
  CreateJobOutcome,
  IntegrationJobsStore,
  JobRecord,
  JobTarget,
  NewJob,
} from '../services/integration-jobs.ts'
import type { EnvelopeRecord } from '../services/integration-delivery.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0

const columns = (sql: Sql) =>
  sql`j.id::text AS "id", j.app_id::text AS "appId", j.grant_id::text AS "grantId", j.farm_id::text AS "farmId", j.printer_assignment_id::text AS "printerAssignmentId", j.idempotency_key AS "idempotencyKey", j.request_hash AS "requestHash", j.file_url AS "fileUrl", j.sha256, j.size_bytes::float8 AS "sizeBytes", j.display_name AS "displayName", j.library_version_id::text AS "libraryVersionId", j.plate, j.storage_mode AS "storageMode", j.resin_profile AS "resinProfile", j.status, j.created_at::float8 AS "createdAt", j.updated_at::float8 AS "updatedAt"`
const returning = (sql: Sql) =>
  sql`id::text AS "id", app_id::text AS "appId", grant_id::text AS "grantId", farm_id::text AS "farmId", printer_assignment_id::text AS "printerAssignmentId", idempotency_key AS "idempotencyKey", request_hash AS "requestHash", file_url AS "fileUrl", sha256, size_bytes::float8 AS "sizeBytes", display_name AS "displayName", library_version_id::text AS "libraryVersionId", plate, storage_mode AS "storageMode", resin_profile AS "resinProfile", status, created_at::float8 AS "createdAt", updated_at::float8 AS "updatedAt"`
function present(row: JobRecord): JobRecord {
  const record = { ...row }
  if (record.libraryVersionId == null) delete record.libraryVersionId
  if (record.plate == null) delete record.plate
  if (record.storageMode == null) delete record.storageMode
  if (record.resinProfile == null) delete record.resinProfile
  return record
}

const envelopeColumns = (sql: Sql) =>
  sql`e.cmd_id::text AS "cmdId", e.app_id::text AS "appId", e.grant_id::text AS "grantId", e.farm_id::text AS "farmId", e.agent_id::text AS "agentId", e.printer_assignment_id::text AS "printerAssignmentId", e.kind, e.resource_id::text AS "resourceId", e.required_scope AS "requiredScope", e.nonce, e.wire, e.issued_at::float8 AS "issuedAt", e.expires_at::float8 AS "expiresAt", e.status, e.refusal_code AS "refusalCode", e.result_detail AS "resultDetail", e.history_entry_id AS "historyEntryId", e.created_at::float8 AS "createdAt", e.updated_at::float8 AS "updatedAt"`

/** The farm_integration_jobs role is the least-privilege caller. */
export class PostgresIntegrationJobs implements IntegrationJobsStore {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }
  async get(id: string, appId: string) {
    if (!uuid.test(id) || !uuid.test(appId)) return null
    const rows = await this.sql<
      JobRecord[]
    >`SELECT ${columns(this.sql)} FROM farm.integration_jobs j WHERE j.id = ${id}::uuid AND j.app_id = ${appId}::uuid`
    if (!rows[0]) return null
    const envelopes = await this.sql<
      EnvelopeRecord[]
    >`SELECT ${envelopeColumns(this.sql)} FROM farm.integration_envelopes e WHERE e.resource_id = ${id}::uuid AND e.kind IN ('job', 'action') ORDER BY CASE e.kind WHEN 'job' THEN 0 ELSE 1 END LIMIT 1`
    return {
      record: present(rows[0]),
      envelope: envelopes[0] ? { ...envelopes[0] } : null,
    }
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
          INSERT INTO farm.integration_jobs (id, app_id, grant_id, farm_id, printer_assignment_id, idempotency_key, request_hash, file_url, sha256, size_bytes, display_name, library_version_id, plate, storage_mode, resin_profile, status, created_at, updated_at)
          VALUES (${job.id}::uuid, ${job.appId}::uuid, ${job.grantId}::uuid, ${job.farmId}::uuid, ${job.printerAssignmentId}::uuid, ${job.idempotencyKey}, ${job.requestHash}, ${job.fileUrl}, ${job.sha256}, ${job.sizeBytes}, ${job.displayName}, ${job.libraryVersionId ?? null}::uuid, ${job.plate ?? null}, ${job.storageMode ?? null}, ${job.resinProfile ?? null}, ${job.status}, ${now}, ${now})
          ON CONFLICT (app_id, idempotency_key) DO NOTHING
          RETURNING ${returning(tx as unknown as Sql)}`
        if (rows[0]) {
          const record = present(rows[0]!)
          await tx`
            INSERT INTO farm.integration_audit (farm_id, app_id, printer_assignment_id, actor_kind, actor_id, action, resource_type, resource_id, outcome, occurred_at, details)
            VALUES (${record.farmId}::uuid, ${record.appId}::uuid, ${record.printerAssignmentId}::uuid, 'app', ${record.appId}, 'job.submitted', 'job', ${record.id}, ${record.status === 'held' ? 'held' : 'accepted'}, ${now}, ${tx.json({ status: record.status })})`
          return { kind: 'created', record }
        }
        const existing = await tx<(JobRecord & { cmdId: string | null })[]>`
          SELECT ${columns(tx as unknown as Sql)},
            (SELECT e.cmd_id::text FROM farm.integration_envelopes e WHERE e.kind IN ('job', 'action') AND e.resource_id = j.id ORDER BY CASE e.kind WHEN 'job' THEN 0 ELSE 1 END LIMIT 1) AS "cmdId"
          FROM farm.integration_jobs j
          WHERE j.app_id = ${job.appId}::uuid AND j.idempotency_key = ${job.idempotencyKey}`
        if (!existing[0]) return { kind: 'refused' }
        const { cmdId, ...rest } = existing[0]
        return { kind: 'existing', record: present(rest), cmdId }
      })
    } catch (cause) {
      // A guard trigger or constraint refused it: grant, scope, assignment, sandbox or bounds.
      const code = (cause as { code?: string }).code
      if (code === 'P0001' || code === '23514') return { kind: 'refused' }
      throw cause
    }
  }
}
