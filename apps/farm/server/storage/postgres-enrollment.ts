import type { Sql } from 'postgres'
import type {
  EnrollmentRecord,
  EnrollmentScope,
  EnrollmentSource,
} from '../services/enrolled-connector-proof.ts'

/** Unwired prototype. Caller owns a dedicated PostgreSQL pool and its lifecycle. */
export class PostgresEnrollmentSource implements EnrollmentSource {
  #sql: Sql
  constructor(sql: Sql) {
    this.#sql = sql
  }
  async withEnrollment(
    scope: EnrollmentScope,
    check: (record: EnrollmentRecord | null) => void,
  ): Promise<void> {
    try {
      const farmId = scope.farmId
      const agentId = scope.agentId
      await this.#sql.begin(async (transaction) => {
        await transaction`SET LOCAL statement_timeout = '2000ms'`
        await transaction`SET LOCAL lock_timeout = '1000ms'`
        const rows = await transaction<EnrollmentRecord[]>`
          SELECT farm_id AS "farmId", agent_id AS "agentId", status,
                 public_key_spki AS "publicKeySpki", fingerprint
          FROM farm.connector_enrollments
          WHERE farm_id = ${farmId}::uuid AND agent_id = ${agentId}::uuid
          FOR SHARE
        `
        // Synchronous proof evaluation stays inside the row lock. No query escapes.
        const result = check(rows[0] ?? null)
        if (result !== undefined) throw new Error()
      })
      // begin resolves only after COMMIT, not merely after the callback.
    } catch {
      throw new Error('Enrollment storage unavailable')
    }
  }
}
