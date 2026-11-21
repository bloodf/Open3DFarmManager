import postgres from 'postgres'
import { createError, useRuntimeConfig, type RequestEvent } from 'nuxt/server'
import { authRuntime } from '../utils/auth/runtime.ts'
import {
  authResponse,
  mutation,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import {
  FeatureError,
  PostgresSpoolDrying,
  type FeatureOperation,
} from '../storage/postgres-spool-drying.ts'
import { labelQr } from '../utils/qr/label.ts'

interface FeatureRuntime {
  sql: ReturnType<typeof postgres>
  drying: PostgresSpoolDrying
}
let store: Promise<FeatureRuntime> | undefined
/** Validated `spoolFeatures` login (role farm_spool_features); shared by the slot routes. */
export async function spoolFeaturesSql() {
  return (await featureRuntime()).sql
}
async function runtime() {
  return (await featureRuntime()).drying
}
async function featureRuntime() {
  const raw: unknown = useRuntimeConfig()['spoolFeatures']
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('enabled' in raw) ||
    raw.enabled !== true ||
    !('databaseUrl' in raw) ||
    typeof raw.databaseUrl !== 'string'
  )
    throw createError({ status: 404, message: 'Recurso indisponível.' })
  if (!store)
    store = (async () => {
      const url = new URL(raw.databaseUrl as string)
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
          await sql`SELECT pg_has_role(current_user,'farm_spool_features','USAGE') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolcanlogin) AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolname NOT IN (current_user,'farm_spool_features'))) AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND (pg_has_role(current_user,c.relowner,'MEMBER') OR has_table_privilege(current_user,c.oid,'TRUNCATE') OR has_table_privilege(current_user,c.oid,'REFERENCES') OR has_table_privilege(current_user,c.oid,'TRIGGER') OR has_table_privilege(current_user,c.oid,'UPDATE') OR ((has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'DELETE') OR has_any_column_privilege(current_user,c.oid,'UPDATE')) AND NOT (n.nspname='farm' AND c.relname=ANY(${['spool_library_settings', 'spool_library_fields', 'spool_locations', 'spool_drying_logs', 'spool_humidity_readings', 'spool_farm_settings', 'spool_slot_assignments', 'spool_usage_records', 'spool_filaments', 'spools', 'session_accounts', 'account_sessions', 'memberships']}::text[]))))) AS allowed`
        if (rows[0]?.allowed !== true) throw new Error('Invalid feature role')
        return { sql, drying: new PostgresSpoolDrying(sql) }
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
const escape = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  )
async function body(req: Request): Promise<Record<string, unknown>> {
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
export async function spoolFeature(
  event: Pick<RequestEvent, 'req' | 'res'>,
  farmId: string,
  op: FeatureOperation,
  supplied: Record<string, unknown> = {},
) {
  const auth = authRuntime()
  authResponse(event)
  if (event.req.method !== 'GET') mutation(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  const input = event.req.method === 'GET' ? supplied : await body(event.req)
  try {
    const result = await (
      await runtime()
    ).run(
      {
        farmId,
        sessionRecordId,
        policy: { idleTimeoutMs: auth.idleTimeoutMs },
      },
      op,
      input,
    )
    if (op !== 'labels') return result
    const rows = result as {
      id: number
      name: string | null
      material: string | null
    }[]
    const labels = rows
      .map((row) => {
        const url = new URL(
          `/api/farms/${farmId}/spool-library/labels/spool/${row.id}`,
          auth.origin,
        ).href
        return `<article>${labelQr(url)}<div><strong>${escape(row.name || row.material || 'Filamento')}</strong><p>Carretel #${row.id}</p></div></article>`
      })
      .join('')
    event.res.headers.set('Content-Type', 'text/html; charset=utf-8')
    event.res.headers.set(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    )
    return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Etiquetas de carretéis</title><style>@page{margin:8mm}body{display:flex;flex-wrap:wrap;gap:4mm;font:12pt sans-serif}article{box-sizing:border-box;border:1px solid #000;display:flex;align-items:center;width:85mm;height:40mm;break-inside:avoid}svg{width:36mm;height:36mm;flex:none}p{margin:2mm 0}</style><body>${labels}</body></html>`
  } catch (e) {
    if (e instanceof FeatureError)
      throw createError({
        status: e.status,
        message: 'Solicitação indisponível.',
      })
    throw createError({ status: 503, message: 'Recurso indisponível.' })
  }
}
