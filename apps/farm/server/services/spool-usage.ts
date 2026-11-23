import postgres from 'postgres'
import { createError, useRuntimeConfig, type RequestEvent } from 'nuxt/server'
import { authRuntime } from '../utils/auth/runtime.ts'
import {
  authResponse,
  mutation,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import {
  PostgresSpoolUsage,
  UsageError,
  type UsageOperation,
} from '../storage/postgres-spool-usage.ts'
import { validateSpoolUsageRole } from './spool-usage-role.ts'
import { toCsv } from './spool-usage-csv.ts'

let store: Promise<PostgresSpoolUsage> | undefined
let pool: ReturnType<typeof postgres> | undefined

/** `spoolUsage` runtime config: a login that is a member of the roles in spool-usage-role.ts. */
export function spoolUsageEnabled(): boolean {
  const raw: unknown = useRuntimeConfig()['spoolUsage']
  return (
    !!raw &&
    typeof raw === 'object' &&
    'enabled' in raw &&
    raw.enabled === true &&
    'databaseUrl' in raw &&
    typeof raw.databaseUrl === 'string'
  )
}

export function spoolUsageRuntime(): Promise<PostgresSpoolUsage> {
  if (!spoolUsageEnabled())
    throw createError({ status: 404, message: 'Recurso indisponível.' })
  const raw = useRuntimeConfig()['spoolUsage'] as { databaseUrl: string }
  if (!store)
    store = (async () => {
      const url = new URL(raw.databaseUrl)
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !url.username ||
        !url.password ||
        url.pathname.length < 2 ||
        url.toString().length > 2048
      )
        throw new Error('Invalid database URL')
      const sql = postgres(url.toString(), {
        max: 3,
        connect_timeout: 3,
        idle_timeout: 20,
        connection: {
          search_path: 'pg_catalog',
          statement_timeout: 5000,
          lock_timeout: 1000,
        },
      })
      pool = sql
      await validateSpoolUsageRole(sql)
      return new PostgresSpoolUsage(sql)
    })().catch(async () => {
      await closeSpoolUsageRuntime().catch(() => {})
      throw createError({ status: 503, message: 'Recurso indisponível.' })
    })
  return store
}

/** Returns the validated pool for farm-scoped integration reads. */
export async function integrationSpoolPool() {
  await spoolUsageRuntime()
  if (!pool) throw new Error('Spool database unavailable')
  return pool
}

export async function closeSpoolUsageRuntime() {
  const closing = pool
  pool = undefined
  store = undefined
  await closing?.end({ timeout: 3 })
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  if (
    req.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json' ||
    req.headers.has('content-encoding')
  )
    throw createError({ status: 415, message: 'Envie JSON.' })
  const reader = req.body?.getReader()
  if (!reader) throw createError({ status: 400, message: 'Dados inválidos.' })
  let size = 0
  const chunks: Uint8Array[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {})
      reject(createError({ status: 408, message: 'Tempo de envio esgotado.' }))
    }, 5000)
  })
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), timeout])
      if (part.done) break
      size += part.value.length
      if (size > 8192)
        throw createError({ status: 413, message: 'Dados muito grandes.' })
      chunks.push(part.value)
    }
    const data: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    )
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Invalid body')
    return data as Record<string, unknown>
  } catch (e) {
    if (e instanceof Error && 'status' in e) throw e
    throw createError({ status: 400, message: 'Dados inválidos.' })
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
}

const NUMERIC = ['spoolId', 'jobId', 'filamentId', 'from', 'to', 'limit']
const TEXT = ['printerId', 'groupBy', 'period', 'format', 'view']

/** Query string to operation input: numbers for numeric keys, unknown keys refused. */
export function usageQuery(url: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of new URL(url, 'http://localhost').searchParams) {
    if (key in out)
      throw createError({ status: 400, message: 'Consulta inválida.' })
    if (NUMERIC.includes(key))
      out[key] = /^\d{1,16}$/.test(value) ? Number(value) : NaN
    else if (TEXT.includes(key)) out[key] = value
    else throw createError({ status: 400, message: 'Consulta inválida.' })
  }
  return out
}

export async function spoolUsageFeature(
  event: Pick<RequestEvent, 'req' | 'res'>,
  farmId: string,
  op: UsageOperation,
  supplied: Record<string, unknown> = {},
) {
  const auth = authRuntime()
  authResponse(event)
  if (event.req.method !== 'GET') mutation(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  const input =
    event.req.method === 'GET'
      ? supplied
      : { ...(await body(event.req)), ...supplied }
  try {
    return await (
      await spoolUsageRuntime()
    ).run(
      {
        farmId,
        sessionRecordId,
        policy: { idleTimeoutMs: auth.idleTimeoutMs },
      },
      op,
      input,
    )
  } catch (e) {
    if (e instanceof UsageError)
      throw createError({
        status: e.status,
        message: 'Solicitação indisponível.',
      })
    if (e && typeof e === 'object' && 'status' in e) throw e
    throw createError({ status: 503, message: 'Recurso indisponível.' })
  }
}

const USAGE_COLUMNS: Record<string, string[]> = {
  job: ['jobId'],
  printer: ['printerId', 'printerKey'],
  filament: ['filamentId', 'filamentName', 'material'],
  period: ['period'],
}
const TOTALS = ['records', 'grams', 'cost', 'unpricedRecords']

type CsvEvent = Pick<RequestEvent, 'req' | 'res'>
function csvResponse(event: CsvEvent, name: string, text: string) {
  event.res.headers.set('Content-Type', 'text/csv; charset=utf-8')
  event.res.headers.set(
    'Content-Disposition',
    `attachment; filename="${name}.csv"`,
  )
  event.res.headers.set('X-Content-Type-Options', 'nosniff')
  return text
}

/** GET usage report; `format=csv` returns CSV, anything else JSON. */
export async function spoolUsageReport(event: CsvEvent, farmId: string) {
  const { format, ...input } = usageQuery(event.req.url)
  if (format !== undefined && format !== 'csv' && format !== 'json')
    throw createError({ status: 400, message: 'Consulta inválida.' })
  const report = (await spoolUsageFeature(
    event,
    farmId,
    'report-usage',
    input,
  )) as {
    currency: string
    groupBy: string
    rows: Record<string, unknown>[]
  }
  if (format !== 'csv') return report
  const columns = [...(USAGE_COLUMNS[report.groupBy] ?? []), ...TOTALS]
  const rows = report.rows.map((row) => ({ ...row, currency: report.currency }))
  return csvResponse(
    event,
    `usage-by-${report.groupBy}`,
    toCsv([...columns, 'currency'], rows),
  )
}

const INVENTORY_COLUMNS = [
  'material',
  'location',
  'spools',
  'remainingGrams',
  'remainingValue',
]
const LOW_STOCK_COLUMNS = [
  'filamentId',
  'name',
  'material',
  'remainingGrams',
  'effectiveThresholdGrams',
]

/** GET inventory report; CSV carries `view=groups` (default) or `view=low-stock`. */
export async function spoolInventoryReport(event: CsvEvent, farmId: string) {
  const { format, view, ...rest } = usageQuery(event.req.url)
  if (
    Object.keys(rest).length > 0 ||
    (format !== undefined && format !== 'csv' && format !== 'json') ||
    (view !== undefined && view !== 'groups' && view !== 'low-stock')
  )
    throw createError({ status: 400, message: 'Consulta inválida.' })
  const report = (await spoolUsageFeature(
    event,
    farmId,
    'report-inventory',
  )) as {
    currency: string
    groups: Record<string, unknown>[]
    lowStock: Record<string, unknown>[]
  }
  if (format !== 'csv') return report
  return view === 'low-stock'
    ? csvResponse(event, 'low-stock', toCsv(LOW_STOCK_COLUMNS, report.lowStock))
    : csvResponse(
        event,
        'inventory',
        toCsv(
          [...INVENTORY_COLUMNS, 'currency'],
          report.groups.map((row) => ({ ...row, currency: report.currency })),
        ),
      )
}
