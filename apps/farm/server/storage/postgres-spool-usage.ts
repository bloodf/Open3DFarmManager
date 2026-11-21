import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionPolicy,
  type SessionRecord,
} from '../utils/auth/session-contract.ts'
import {
  adjustSpool,
  filamentRemaining,
  type JobUsageItem,
  resolveJobSlots,
  gramsFromMillimetres,
} from '../services/spool-usage-ledger.ts'

export interface UsageAuthority {
  farmId: string
  sessionRecordId: string
  policy: SessionPolicy
}
export type UsageOperation =
  | 'usage-list'
  | 'usage-record'
  | 'usage-correct'
  | 'settings-get'
  | 'settings-set'
  | 'filament-threshold'
  | 'low-stock-list'
  | 'report-usage'
  | 'report-inventory'

export class UsageError extends Error {
  readonly status: number
  constructor(status: number) {
    super('Spool usage request rejected')
    this.status = status
  }
}
const reject = (status: number): never => {
  throw new UsageError(status)
}
const id = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x > 0
const time = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
const uuid = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x)
const numeric = (x: unknown, min: number, max: number): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max
const MAX_GRAMS = 1_000_000

/** Roles allowed to record or correct usage; viewers only read; settings need owner/admin. */
const WRITE_ROLES = ['owner', 'admin', 'operator']
const SETTINGS_ROLES = ['owner', 'admin']
const MUTATIONS: Partial<Record<UsageOperation, string[]>> = {
  'usage-record': WRITE_ROLES,
  'usage-correct': WRITE_ROLES,
  'settings-set': SETTINGS_ROLES,
  'filament-threshold': SETTINGS_ROLES,
}

/** `cost` = (spool price, else filament price) / initial weight * grams. */
const COST = (grams: string) =>
  `CASE WHEN COALESCE(s.price, f.price) IS NOT NULL AND NULLIF(COALESCE(s.initial_weight, f.weight), 0) IS NOT NULL THEN COALESCE(s.price, f.price) / NULLIF(COALESCE(s.initial_weight, f.weight), 0) * ${grams} END`

export class PostgresSpoolUsage {
  private readonly sql: Sql
  private readonly clock: () => number
  constructor(sql: Sql, clock: () => number = Date.now) {
    this.sql = sql
    this.clock = clock
  }

  /** Session-authenticated, farm-scoped operation. */
  async run(
    authority: UsageAuthority,
    operation: UsageOperation,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (
      !uuid(authority.farmId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(authority.sessionRecordId)
    )
      reject(400)
    return this.sql.begin(async (tx) => {
      const accounts = await tx<
        AccountSessionState[]
      >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id=(SELECT account_id FROM farm.account_sessions WHERE id=${authority.sessionRecordId}) FOR SHARE`
      const sessions = await tx<
        SessionRecord[]
      >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id=${authority.sessionRecordId} FOR UPDATE`
      const now = this.clock()
      const decision = evaluateSession(
        authority.sessionRecordId,
        sessions[0] ?? null,
        accounts[0] ?? null,
        now,
        authority.policy,
      )
      if (!decision.ok) return reject(401)
      const members =
        await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id=${authority.farmId}::uuid AND account_id=${decision.accountId} FOR SHARE`
      const role: unknown =
        members[0]?.revoked_at === null ? members[0]?.role : null
      if (!['owner', 'admin', 'operator', 'viewer'].includes(role as string))
        return reject(404)
      const allowed = MUTATIONS[operation]
      if (allowed && !allowed.includes(role as string)) return reject(403)
      if (allowed)
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${authority.farmId},0))`
      const result = await this.execute(
        tx,
        authority.farmId,
        decision.accountId,
        operation,
        input,
        now,
      )
      const after = this.clock()
      if (
        after < now ||
        !evaluateSession(
          authority.sessionRecordId,
          sessions[0] ?? null,
          accounts[0] ?? null,
          after,
          authority.policy,
        ).ok
      )
        return reject(401)
      await tx`UPDATE farm.account_sessions SET last_seen_at=${after} WHERE id=${authority.sessionRecordId}`
      return result
    })
  }

  private async execute(
    tx: TransactionSql,
    farm: string,
    accountId: string,
    op: UsageOperation,
    input: Record<string, unknown>,
    now: number,
  ): Promise<unknown> {
    if (op === 'usage-list') return this.list(tx, farm, input)
    if (op === 'usage-record')
      return this.record(tx, farm, accountId, input, now)
    if (op === 'usage-correct')
      return this.correct(tx, farm, accountId, input, now)
    if (op === 'settings-get' || op === 'settings-set')
      return this.settings(tx, farm, op === 'settings-set', input, now)
    if (op === 'filament-threshold') return this.threshold(tx, farm, input)
    if (op === 'low-stock-list') return this.lowStock(tx, farm)
    if (op === 'report-usage') return this.usageReport(tx, farm, input)
    return this.inventoryReport(tx, farm)
  }

  private async list(
    tx: TransactionSql,
    farm: string,
    input: Record<string, unknown>,
  ) {
    const f = filters(input)
    const limit = input.limit === undefined ? 200 : input.limit
    if (!numeric(limit, 1, 1000) || !Number.isInteger(limit)) return reject(400)
    const rows =
      await tx`SELECT u.id, u.spool_id::float8 AS "spoolId", u.job_id::float8 AS "jobId", u.printer_id AS "printerId", u.grams, u.source, u.corrected_by AS "correctedBy", u.created_at::float8 AS "createdAt", ${tx.unsafe(COST('u.grams'))}::float8 AS cost
      FROM farm.spool_usage_records u JOIN farm.spools s ON s.farm_id=u.farm_id AND s.id=u.spool_id JOIN farm.spool_filaments f ON f.farm_id=s.farm_id AND f.id=s.filament_id
      WHERE u.farm_id=${farm}::uuid AND (${f.spoolId}::bigint IS NULL OR u.spool_id=${f.spoolId}) AND (${f.jobId}::bigint IS NULL OR u.job_id=${f.jobId}) AND (${f.printerId}::uuid IS NULL OR u.printer_id=${f.printerId}::uuid) AND (${f.filamentId}::bigint IS NULL OR s.filament_id=${f.filamentId}) AND (${f.from}::bigint IS NULL OR u.created_at>=${f.from}) AND (${f.to}::bigint IS NULL OR u.created_at<${f.to})
      ORDER BY u.created_at DESC, u.id LIMIT ${limit}`
    return { currency: await currency(tx, farm), records: rows }
  }

  private async record(
    tx: TransactionSql,
    farm: string,
    accountId: string,
    input: Record<string, unknown>,
    now: number,
  ) {
    const source = input.source === undefined ? 'manual' : input.source
    if (
      !id(input.spoolId) ||
      !numeric(input.grams, 0, MAX_GRAMS) ||
      (input.jobId != null && !id(input.jobId)) ||
      (input.printerId != null && !uuid(input.printerId)) ||
      (source !== 'manual' && source !== 'api')
    )
      return reject(400)
    if (input.grams === 0) return reject(400)
    const jobId = (input.jobId as number | null | undefined) ?? null
    const printerId = (input.printerId as string | null | undefined) ?? null
    const recordId = randomUUID()
    const rows =
      await tx`INSERT INTO farm.spool_usage_records (farm_id,id,spool_id,job_id,printer_id,grams,source,corrected_by,created_at)
      SELECT ${farm}::uuid,${recordId}::uuid,s.id,${jobId},${printerId}::uuid,${input.grams as number},${source},${accountId},${now}
      FROM farm.spools s WHERE s.farm_id=${farm}::uuid AND s.id=${input.spoolId}
        AND (${jobId}::bigint IS NULL OR EXISTS (SELECT 1 FROM farm.job_history j WHERE j.farm_id=${farm}::uuid AND j.id=${jobId}))
        AND (${printerId}::uuid IS NULL OR EXISTS (SELECT 1 FROM farm.printer_assignments p WHERE p.farm_id=${farm}::uuid AND p.id=${printerId}::uuid))
      RETURNING id`
    if (!rows[0]) return reject(404)
    const effect = await adjustSpool(
      tx,
      farm,
      input.spoolId,
      input.grams,
      now,
      now,
      printerId,
    )
    return { id: recordId, ...effect }
  }

  private async correct(
    tx: TransactionSql,
    farm: string,
    accountId: string,
    input: Record<string, unknown>,
    now: number,
  ) {
    if (!uuid(input.id) || !numeric(input.grams, 0, MAX_GRAMS))
      return reject(400)
    const existing = await tx<
      { spoolId: number; grams: number; printerId: string | null }[]
    >`SELECT spool_id::float8 AS "spoolId", grams, printer_id AS "printerId" FROM farm.spool_usage_records WHERE farm_id=${farm}::uuid AND id=${input.id}::uuid`
    const row = existing[0]
    if (!row) return reject(404)
    await tx`UPDATE farm.spool_usage_records SET grams=${input.grams}, corrected_by=${accountId} WHERE farm_id=${farm}::uuid AND id=${input.id}::uuid`
    const effect = await adjustSpool(
      tx,
      farm,
      row.spoolId,
      input.grams - row.grams,
      now,
      now,
      row.printerId,
    )
    return {
      id: input.id,
      previousGrams: row.grams,
      grams: input.grams,
      ...effect,
    }
  }

  private async settings(
    tx: TransactionSql,
    farm: string,
    write: boolean,
    input: Record<string, unknown>,
    now: number,
  ) {
    if (write) {
      const threshold = input.defaultLowStockThresholdGrams
      const money = input.currency
      if (
        (threshold !== undefined &&
          threshold !== null &&
          !numeric(threshold, 0, MAX_GRAMS)) ||
        (money !== undefined &&
          !(typeof money === 'string' && /^[A-Z]{3}$/.test(money))) ||
        (threshold === undefined && money === undefined)
      )
        return reject(400)
      const current = await readSettings(tx, farm)
      const nextThreshold =
        threshold === undefined
          ? current.defaultLowStockThresholdGrams
          : (threshold as number | null)
      const nextCurrency = (money as string | undefined) ?? current.currency
      await tx`INSERT INTO farm.spool_farm_settings (farm_id, default_low_stock_threshold_grams, currency, updated_at)
        VALUES (${farm}::uuid, ${nextThreshold}, ${nextCurrency}, ${now})
        ON CONFLICT (farm_id) DO UPDATE SET default_low_stock_threshold_grams=EXCLUDED.default_low_stock_threshold_grams, currency=EXCLUDED.currency, updated_at=EXCLUDED.updated_at`
    }
    return readSettings(tx, farm)
  }

  private async threshold(
    tx: TransactionSql,
    farm: string,
    input: Record<string, unknown>,
  ) {
    const grams = input.thresholdGrams
    if (
      !id(input.filamentId) ||
      (grams !== null && !numeric(grams, 0, MAX_GRAMS))
    )
      return reject(400)
    const rows =
      await tx`UPDATE farm.spool_filaments SET low_stock_threshold_grams=${grams as number | null} WHERE farm_id=${farm}::uuid AND id=${input.filamentId} RETURNING id`
    return rows[0]
      ? { filamentId: input.filamentId, thresholdGrams: grams }
      : reject(404)
  }

  private async lowStock(tx: TransactionSql, farm: string) {
    const settings = await readSettings(tx, farm)
    return { ...settings, filaments: await stockRows(tx, farm) }
  }

  private async usageReport(
    tx: TransactionSql,
    farm: string,
    input: Record<string, unknown>,
  ) {
    const f = filters(input)
    const groupBy = input.groupBy ?? 'filament'
    const period = input.period ?? 'day'
    if (
      !['job', 'printer', 'filament', 'period'].includes(groupBy as string) ||
      !['day', 'week', 'month'].includes(period as string)
    )
      return reject(400)
    const base = tx`WITH r AS (
      SELECT u.job_id, u.printer_id, p.printer_key, u.created_at, u.grams, s.filament_id, f.name AS filament_name, f.material, ${tx.unsafe(COST('u.grams'))} AS cost
      FROM farm.spool_usage_records u JOIN farm.spools s ON s.farm_id=u.farm_id AND s.id=u.spool_id JOIN farm.spool_filaments f ON f.farm_id=s.farm_id AND f.id=s.filament_id
      LEFT JOIN farm.printer_assignments p ON p.farm_id=u.farm_id AND p.id=u.printer_id
      WHERE u.farm_id=${farm}::uuid AND (${f.spoolId}::bigint IS NULL OR u.spool_id=${f.spoolId}) AND (${f.jobId}::bigint IS NULL OR u.job_id=${f.jobId}) AND (${f.printerId}::uuid IS NULL OR u.printer_id=${f.printerId}::uuid) AND (${f.filamentId}::bigint IS NULL OR s.filament_id=${f.filamentId}) AND (${f.from}::bigint IS NULL OR u.created_at>=${f.from}) AND (${f.to}::bigint IS NULL OR u.created_at<${f.to})
    )`
    const totals = tx`count(*)::int AS records, COALESCE(sum(grams),0)::float8 AS grams, sum(cost)::float8 AS cost, (count(*) FILTER (WHERE cost IS NULL))::int AS "unpricedRecords"`
    const rows =
      groupBy === 'job'
        ? await tx`${base} SELECT job_id::float8 AS "jobId", ${totals} FROM r GROUP BY job_id ORDER BY job_id DESC NULLS LAST LIMIT 5000`
        : groupBy === 'printer'
          ? await tx`${base} SELECT printer_id AS "printerId", printer_key AS "printerKey", ${totals} FROM r GROUP BY printer_id, printer_key ORDER BY printer_key NULLS LAST, printer_id LIMIT 5000`
          : groupBy === 'filament'
            ? await tx`${base} SELECT filament_id::float8 AS "filamentId", filament_name AS "filamentName", material, ${totals} FROM r GROUP BY filament_id, filament_name, material ORDER BY filament_id LIMIT 5000`
            : await tx`${base} SELECT to_char(date_trunc(${period as string}, to_timestamp(created_at/1000.0) AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS period, ${totals} FROM r GROUP BY 1 ORDER BY 1 LIMIT 5000`
    return {
      currency: await currency(tx, farm),
      groupBy,
      ...(groupBy === 'period' ? { period } : {}),
      rows,
    }
  }

  private async inventoryReport(tx: TransactionSql, farm: string) {
    const groups =
      await tx`SELECT f.material, s.location, count(*)::int AS spools,
        COALESCE(sum(GREATEST(COALESCE(s.initial_weight, f.weight) - s.used_weight, 0)),0)::float8 AS "remainingGrams",
        sum(CASE WHEN COALESCE(s.price, f.price) IS NOT NULL AND NULLIF(COALESCE(s.initial_weight, f.weight),0) IS NOT NULL THEN COALESCE(s.price, f.price) / NULLIF(COALESCE(s.initial_weight, f.weight),0) * GREATEST(COALESCE(s.initial_weight, f.weight) - s.used_weight, 0) END)::float8 AS "remainingValue"
      FROM farm.spools s JOIN farm.spool_filaments f ON f.farm_id=s.farm_id AND f.id=s.filament_id
      WHERE s.farm_id=${farm}::uuid AND NOT s.archived
      GROUP BY f.material, s.location ORDER BY f.material NULLS LAST, s.location NULLS LAST LIMIT 5000`
    const stock = await stockRows(tx, farm)
    return {
      currency: await currency(tx, farm),
      generatedAt: this.clock(),
      groups,
      lowStock: stock.filter((row) => row.low),
    }
  }

  // ---- system operations (no session): job completion -------------------

  /** Records usage for one finished job. Idempotent: a job is recorded once. */
  async recordJob(
    farmId: string,
    jobId: number,
  ): Promise<{ records: number; alerts: number }> {
    if (!uuid(farmId) || !id(jobId)) return { records: 0, alerts: 0 }
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${farmId},0))`
      return this.recordJobIn(tx, farmId, jobId)
    })
  }

  private async recordJobIn(tx: TransactionSql, farm: string, jobId: number) {
    const none = { records: 0, alerts: 0 }
    const jobs = await tx<
      {
        agentId: string
        printerKey: string
        usage: unknown
        endedAt: number
        printSeconds: number | null
        totalSeconds: number | null
      }[]
    >`SELECT agent_id AS "agentId", printer_key AS "printerKey", filament_usage AS usage, ended_at::float8 AS "endedAt", print_duration_seconds AS "printSeconds", total_duration_seconds AS "totalSeconds" FROM farm.job_history WHERE farm_id=${farm}::uuid AND id=${jobId}`
    const job = jobs[0]
    if (!job || !Array.isArray(job.usage) || job.usage.length === 0) return none
    const done =
      await tx`SELECT 1 FROM farm.spool_usage_records WHERE farm_id=${farm}::uuid AND job_id=${jobId} AND source='telemetry' LIMIT 1`
    if (done.length > 0) return none
    const printers = await tx<
      { id: string }[]
    >`SELECT id FROM farm.printer_assignments WHERE farm_id=${farm}::uuid AND agent_id=${job.agentId}::uuid AND printer_key=${job.printerKey} ORDER BY revoked_at NULLS FIRST, id LIMIT 1`
    const printerId = printers[0]?.id
    if (!printerId) return none
    const seconds = job.totalSeconds ?? job.printSeconds ?? 0
    const startedAt = Math.max(0, Math.round(job.endedAt - seconds * 1000))
    const items: JobUsageItem[] = []
    for (const raw of job.usage as unknown[]) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      if (typeof entry.tool !== 'string') continue
      items.push({
        tool: entry.tool,
        grams: typeof entry.grams === 'number' ? entry.grams : undefined,
        millimetres:
          typeof entry.millimetres === 'number' ? entry.millimetres : undefined,
      })
    }
    const resolved = await resolveJobSlots(
      tx,
      farm,
      printerId,
      startedAt,
      items,
    )
    let records = 0
    let alerts = 0
    for (const { spoolId, item, diameter, density } of resolved) {
      const grams =
        item.grams !== undefined
          ? item.grams
          : item.millimetres !== undefined
            ? gramsFromMillimetres(item.millimetres, diameter, density)
            : 0
      if (!Number.isFinite(grams) || grams <= 0 || grams > MAX_GRAMS) continue
      await tx`INSERT INTO farm.spool_usage_records (farm_id,id,spool_id,job_id,printer_id,grams,source,created_at) VALUES (${farm}::uuid,${randomUUID()}::uuid,${spoolId},${jobId},${printerId}::uuid,${grams},'telemetry',${job.endedAt})`
      const effect = await adjustSpool(
        tx,
        farm,
        spoolId,
        grams,
        job.endedAt,
        job.endedAt,
        printerId,
      )
      records++
      if (effect.alerted) alerts++
    }
    return { records, alerts }
  }

  /**
   * Finds recently ended jobs with filament usage and no telemetry record yet.
   * Jobs whose slots resolve to no spool are looked at again until they leave
   * the window; that is cheap and never double-counts.
   */
  async sweep(input: { sinceMs: number; limit?: number }) {
    const limit = input.limit ?? 100
    const since = Math.max(0, this.clock() - input.sinceMs)
    const candidates = await this.sql<
      { farmId: string; id: number }[]
    >`SELECT j.farm_id AS "farmId", j.id::float8 AS id FROM farm.job_history j
      WHERE j.ended_at>=${since} AND j.filament_usage IS NOT NULL AND jsonb_array_length(j.filament_usage)>0
        AND NOT EXISTS (SELECT 1 FROM farm.spool_usage_records u WHERE u.farm_id=j.farm_id AND u.job_id=j.id AND u.source='telemetry')
      ORDER BY j.ended_at LIMIT ${limit}`
    let records = 0
    let alerts = 0
    for (const job of candidates) {
      const result = await this.recordJob(job.farmId, job.id)
      records += result.records
      alerts += result.alerts
    }
    return { jobs: candidates.length, records, alerts }
  }
}

function filters(input: Record<string, unknown>) {
  const out = {
    spoolId: input.spoolId ?? null,
    jobId: input.jobId ?? null,
    printerId: input.printerId ?? null,
    filamentId: input.filamentId ?? null,
    from: input.from ?? null,
    to: input.to ?? null,
  }
  if (
    (out.spoolId !== null && !id(out.spoolId)) ||
    (out.jobId !== null && !id(out.jobId)) ||
    (out.filamentId !== null && !id(out.filamentId)) ||
    (out.printerId !== null && !uuid(out.printerId)) ||
    (out.from !== null && !time(out.from)) ||
    (out.to !== null && !time(out.to))
  )
    return reject(400)
  return out as {
    spoolId: number | null
    jobId: number | null
    printerId: string | null
    filamentId: number | null
    from: number | null
    to: number | null
  }
}

async function readSettings(tx: TransactionSql, farm: string) {
  const rows = await tx<
    { defaultLowStockThresholdGrams: number | null; currency: string }[]
  >`SELECT default_low_stock_threshold_grams AS "defaultLowStockThresholdGrams", currency FROM farm.spool_farm_settings WHERE farm_id=${farm}::uuid`
  return rows[0] ?? { defaultLowStockThresholdGrams: null, currency: 'USD' }
}
const currency = async (tx: TransactionSql, farm: string) =>
  (await readSettings(tx, farm)).currency

/** Every filament with a known remaining weight, its effective threshold and low flag. */
async function stockRows(tx: TransactionSql, farm: string) {
  const settings = await readSettings(tx, farm)
  const filaments = await tx<
    {
      id: number
      name: string | null
      material: string | null
      thresholdGrams: number | null
    }[]
  >`SELECT id::float8 AS id, name, material, low_stock_threshold_grams AS "thresholdGrams" FROM farm.spool_filaments WHERE farm_id=${farm}::uuid ORDER BY id LIMIT 5000`
  const out = []
  for (const filament of filaments) {
    const stock = await filamentRemaining(tx, farm, filament.id)
    const effective =
      filament.thresholdGrams ?? settings.defaultLowStockThresholdGrams
    out.push({
      filamentId: filament.id,
      name: filament.name,
      material: filament.material,
      remainingGrams: stock,
      thresholdGrams: filament.thresholdGrams,
      effectiveThresholdGrams: effective,
      low: stock !== null && effective !== null && stock <= effective,
    })
  }
  return out
}
