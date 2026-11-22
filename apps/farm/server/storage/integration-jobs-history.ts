import type { Sql } from 'postgres'
import { PostgresIntegrationDelivery } from './integration-delivery-postgres.ts'

const endReference = /^0(?:0|[1-9][0-9]{0,15})$/
const detailPrefix = 'telemetry-ended-at:'

/** Store the Connector's timestamp reference internally, keeping the public
 * historyEntryId reserved for real Farm row IDs. Telemetry can arrive later. */
export class PostgresIntegrationJobDelivery extends PostgresIntegrationDelivery {
  override transition(
    ...[cmdId, from, to, now, result]: Parameters<
      PostgresIntegrationDelivery['transition']
    >
  ) {
    const link = result?.historyEntryId
    if (link && endReference.test(link) && !result?.detail) {
      const endedAt = Number(link.slice(1))
      if (Number.isSafeInteger(endedAt)) {
        return super.transition(cmdId, from, to, now, {
          detail: detailPrefix + endedAt,
        })
      }
    }
    return super.transition(cmdId, from, to, now, result)
  }
}

type HistoryIdentity = {
  id: string
  farmId: string
  printerId: string
  agentId: string
  outcome: string
  endedAt: number | string
}

export async function integrationHistoryJobIds(
  sql: Sql,
  rows: HistoryIdentity[],
  appId?: string,
) {
  // A history row on its own carries no verified integration-app identity.
  if (!appId || !rows.length) return new Map<string, string>()
  const links = await sql<{ id: string; jobId: string }[]>`
    SELECT r.id, min(e.resource_id::text) AS "jobId"
    FROM jsonb_to_recordset(${sql.json(
      rows.map(({ id, farmId, printerId, agentId, outcome, endedAt }) => ({
        id,
        farm: farmId,
        printer: printerId,
        agent: agentId,
        outcome,
        ended: String(endedAt),
      })),
    )}::jsonb) AS r(id text, farm uuid, printer uuid, agent uuid, outcome text, ended text)
    JOIN farm.integration_envelopes e
      ON e.farm_id = r.farm AND e.printer_assignment_id = r.printer AND e.agent_id = r.agent
      AND e.app_id = ${appId}::uuid
      AND e.kind = 'job' AND e.status = r.outcome
      AND (e.history_entry_id = r.id OR e.result_detail = ${detailPrefix} || r.ended)
    GROUP BY r.id HAVING count(*) = 1`
  return new Map(links.map(({ id, jobId }) => [id, jobId]))
}
