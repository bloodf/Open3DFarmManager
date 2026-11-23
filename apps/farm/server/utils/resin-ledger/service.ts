import postgres from 'postgres'
import { createError, useRuntimeConfig, type RequestEvent } from 'nuxt/server'
import { authRuntime } from '../auth/runtime.ts'
import {
  authResponse,
  mutation,
  sealedSessionRecordId,
} from '../../services/authenticated-session.ts'
import {
  PostgresResinLedger,
  ResinLedgerError,
} from '../../storage/resin-ledger-postgres.ts'
import { resinLedgerListQuery, resinLedgerRecordBody } from './request.ts'
import { summarizeResinLedger } from './summary.ts'

type Event = Pick<RequestEvent, 'req' | 'res'>
const TABLES = [
  'resin_ledger_entries',
  'session_accounts',
  'account_sessions',
  'memberships',
]
let store: Promise<PostgresResinLedger> | undefined

/** Runtime config `resinLedger`, or the matching NUXT_RESIN_LEDGER_* environment. */
function configuration(): { enabled: boolean; databaseUrl: string } {
  const raw: unknown = useRuntimeConfig()['resinLedger']
  if (raw && typeof raw === 'object') {
    const { enabled, databaseUrl } = raw as Record<string, unknown>
    return { enabled: enabled === true, databaseUrl: String(databaseUrl ?? '') }
  }
  return {
    enabled: process.env.NUXT_RESIN_LEDGER_ENABLED === 'true',
    databaseUrl: process.env.NUXT_RESIN_LEDGER_DATABASE_URL ?? '',
  }
}
function runtime(): Promise<PostgresResinLedger> {
  const config = configuration()
  if (!config.enabled || !config.databaseUrl)
    throw createError({ status: 404, message: 'Recurso indisponível.' })
  if (!store)
    store = (async () => {
      const url = new URL(config.databaseUrl)
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
          statement_timeout: 2000,
          lock_timeout: 1000,
        },
      })
      try {
        const rows =
          await sql`SELECT pg_has_role(current_user,'farm_resin_ledger','USAGE') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolcanlogin) AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolname NOT IN (current_user,'farm_resin_ledger'))) AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND (pg_has_role(current_user,c.relowner,'MEMBER') OR has_table_privilege(current_user,c.oid,'TRUNCATE') OR has_table_privilege(current_user,c.oid,'REFERENCES') OR has_table_privilege(current_user,c.oid,'TRIGGER') OR has_table_privilege(current_user,c.oid,'UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE') OR ((has_table_privilege(current_user,c.oid,'INSERT') OR has_any_column_privilege(current_user,c.oid,'UPDATE')) AND NOT (n.nspname='farm' AND c.relname=ANY(${TABLES}::text[]))))) AS allowed`
        if (rows[0]?.allowed !== true) throw new Error('Invalid resin role')
        return new PostgresResinLedger(sql)
      } catch (e) {
        await sql.end({ timeout: 3 })
        throw e
      }
    })().catch(() => {
      store = undefined
      throw createError({ status: 503, message: 'Recurso indisponível.' })
    })
  return store
}

async function body(req: Request): Promise<unknown> {
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
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 4096)
        throw createError({ status: 413, message: 'Dados muito grandes.' })
      chunks.push(part.value)
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown
  } catch (e) {
    if (e instanceof Error && 'status' in e) throw e
    throw createError({ status: 400, message: 'Dados inválidos.' })
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (e) {
    if (e instanceof ResinLedgerError)
      throw createError({
        status: e.status,
        message: 'Solicitação indisponível.',
      })
    if (e && typeof e === 'object' && 'status' in e) throw e
    throw createError({ status: 503, message: 'Recurso indisponível.' })
  }
}

export async function listResinLedger(event: Event, query: unknown) {
  const auth = authRuntime()
  authResponse(event)
  const parsed = resinLedgerListQuery.safeParse(query)
  if (!parsed.success)
    throw createError({ status: 400, message: 'Dados inválidos.' })
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  return guarded(async () => {
    const records = await (
      await runtime()
    ).run(
      {
        farmId: parsed.data.farmId,
        sessionRecordId,
        policy: { idleTimeoutMs: auth.idleTimeoutMs },
      },
      { op: 'list', printerKey: parsed.data.printerKey },
    )
    if (!Array.isArray(records)) throw new ResinLedgerError(503)
    return { entries: records, summary: summarizeResinLedger(records) }
  })
}

export async function recordResinLedger(event: Event) {
  const auth = authRuntime()
  mutation(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  const parsed = resinLedgerRecordBody.safeParse(await body(event.req))
  if (!parsed.success)
    throw createError({ status: 400, message: 'Dados inválidos.' })
  return guarded(async () =>
    (await runtime()).run(
      {
        farmId: parsed.data.farmId,
        sessionRecordId,
        policy: { idleTimeoutMs: auth.idleTimeoutMs },
      },
      {
        op: 'record',
        printerKey: parsed.data.printerKey,
        entry: parsed.data.entry,
      },
    ),
  )
}
