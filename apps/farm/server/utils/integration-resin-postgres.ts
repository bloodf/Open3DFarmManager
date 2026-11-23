import type { Sql } from 'postgres'
import { recordFromRow, type ResinLedgerRow } from './resin-ledger/record.ts'
import type {
  IntegrationResinReader,
  ResinPrinterLedger,
  ResinRunRow,
} from './integration-resin.ts'

const ENTRIES_PER_PRINTER = 500
const RUNS_PER_PRINTER = 20

/**
 * Reads the farm resin ledger for the Integration API.
 */
export function postgresResinReader(sql: Sql): IntegrationResinReader {
  return {
    async readLedgers(input) {
      const printers = await sql<
        { id: string; farmId: string; printerKey: string }[]
      >`SELECT a.id::text AS id, a.farm_id::text AS "farmId", a.printer_key AS "printerKey"
        FROM farm.printer_assignments a
        WHERE a.revoked_at IS NULL
          AND (a.farm_id = ANY(${input.farmWideFarmIds}::uuid[]) OR a.id = ANY(${input.assignmentIds}::uuid[]))
          AND (${input.farmId ?? null}::uuid IS NULL OR a.farm_id = ${input.farmId ?? null}::uuid)
          AND (${input.afterId ?? null}::uuid IS NULL OR a.id > ${input.afterId ?? null}::uuid)
          AND EXISTS (SELECT 1 FROM farm.resin_ledger_entries e WHERE e.farm_id = a.farm_id AND e.printer_id = a.id)
        ORDER BY a.id
        LIMIT ${input.limit}`
      if (!printers.length) return []
      const rows = await sql<(ResinLedgerRow & { printerId: string })[]>`
        SELECT id::text AS id, printer_id::text AS "printerId", kind, target, name,
          volume_ml AS "volumeMl", layers::float8 AS layers, hours, source,
          recorded_at::float8 AS "recordedAt"
        FROM (
          SELECT e.id, e.printer_id, e.kind, e.target, e.name, e.volume_ml,
            e.layers, e.hours, e.source, e.recorded_at, row_number() OVER (PARTITION BY e.printer_id ORDER BY e.recorded_at DESC, e.id DESC) AS position
          FROM farm.resin_ledger_entries e
          WHERE e.printer_id = ANY(${printers.map((p) => p.id)}::uuid[])
        ) ranked
        WHERE position <= ${ENTRIES_PER_PRINTER}
        ORDER BY recorded_at DESC, id DESC`
      return printers.map<ResinPrinterLedger>((printer) => ({
        printerId: printer.id,
        farmId: printer.farmId,
        printerKey: printer.printerKey,
        records: rows.flatMap((row) =>
          row.printerId === printer.id ? (recordFromRow(row) ?? []) : [],
        ),
      }))
    },
    async readRuns(printerIds) {
      if (!printerIds.length) return []
      return sql<ResinRunRow[]>`
        SELECT id::text AS id, "printerId", outcome, "endedAt" FROM (
          SELECT h.id, p.id::text AS "printerId", h.outcome, h.ended_at::float8 AS "endedAt",
            row_number() OVER (PARTITION BY p.id ORDER BY h.ended_at DESC, h.id DESC) AS position
          FROM farm.job_history h
          JOIN farm.printer_assignments p ON p.farm_id = h.farm_id AND p.agent_id = h.agent_id
            AND p.printer_key = h.printer_key AND p.revoked_at IS NULL
          WHERE p.id = ANY(${printerIds}::uuid[])
        ) ranked
        WHERE position <= ${RUNS_PER_PRINTER}
        ORDER BY "endedAt" DESC, ranked.id DESC`
    },
  }
}
