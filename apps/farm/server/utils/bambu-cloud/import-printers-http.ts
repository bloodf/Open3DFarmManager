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
  MemoryBambuCloudAccountStore,
  type BambuCloudAccountStore,
  type BambuCloudFailure,
} from './account.ts'
import { bambuCloudDatabaseStore } from './postgres.ts'
import { openBambuCloudSecret } from './secret.ts'
import {
  listBambuCloudAccountPrinters,
  type BambuCloudImportPrintersOk,
} from './import-printers.ts'

const logger = createLogger('bambu-cloud-printers')

export type BambuCloudImportCredentials = {
  accessToken: string
  endpoint: string
}

export type BambuCloudImportCredentialSource = {
  load(
    farmId: string,
  ): Promise<
    | { ok: true; credentials: BambuCloudImportCredentials }
    | { ok: false; reason: BambuCloudFailure }
  >
}

function invalid() {
  return createError({ status: 400, message: 'Solicitação inválida.' })
}

function failure(reason: BambuCloudFailure): never {
  if (reason === 'invalid-input') throw invalid()
  if (reason === 'not-found' || reason === 'cloud-disabled')
    throw createError({
      status: 404,
      message: 'Conta Bambu Cloud indisponível para esta farm.',
    })
  if (reason === 'forbidden')
    throw createError({
      status: 403,
      message:
        'Apenas o proprietário importa impressoras da conta Bambu Cloud.',
    })
  if (reason === 'cloud-unauthorized')
    throw createError({
      status: 422,
      message: 'A nuvem Bambu recusou o token da conta.',
    })
  if (reason === 'cloud-rejected')
    throw createError({
      status: 422,
      message: 'Não foi possível listar as impressoras na nuvem Bambu local.',
    })
  throw createError({
    status: 503,
    message: 'Conta Bambu Cloud indisponível. Tente novamente.',
  })
}

function masterKey(): string {
  const auth = useRuntimeConfig().auth
  if (
    typeof auth !== 'object' ||
    auth === null ||
    !('sessionSecret' in auth) ||
    typeof auth.sessionSecret !== 'string' ||
    auth.sessionSecret.length < 32
  )
    throw createError({
      status: 503,
      message: 'Conta Bambu Cloud indisponível. Tente novamente.',
    })
  return auth.sessionSecret
}

function databaseUrl(): string {
  const value = process.env.OPENFARM_BAMBU_CLOUD_DATABASE_URL
  if (!value || value.length > 2048)
    throw createError({
      status: 503,
      message: 'Conta Bambu Cloud indisponível. Tente novamente.',
    })
  return value
}

function parseKnownSerials(raw: string | null): string[] | undefined {
  if (raw === null || raw === '') return undefined
  if (raw.length > 4096) throw invalid()
  const parts = raw.split(',')
  if (parts.length > 256) throw invalid()
  const serials: string[] = []
  for (const part of parts) {
    const serial = part.trim()
    if (!/^[0-9A-Z]{10,20}$/.test(serial)) throw invalid()
    serials.push(serial)
  }
  return serials
}

/** Opens sealed tokens from the in-memory account store used by unit tests. */
export function memoryBambuCloudImportCredentials(
  store: MemoryBambuCloudAccountStore,
  master: string,
  endpoint: string,
): BambuCloudImportCredentialSource {
  return {
    async load(farmId) {
      const sealed = store.inspect(farmId)
      if (!sealed) return { ok: false, reason: 'not-found' }
      try {
        return {
          ok: true,
          credentials: {
            accessToken: openBambuCloudSecret(sealed.access, master),
            endpoint,
          },
        }
      } catch {
        return { ok: false, reason: 'storage-unavailable' }
      }
    },
  }
}

let credentialSql: Sql | undefined

function credentialDatabase(databaseUrlValue: string): Sql {
  if (credentialSql) return credentialSql
  const url = new URL(databaseUrlValue)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    url.pathname.length < 2
  )
    throw new Error('invalid bambu cloud database url')
  credentialSql = postgres(url.toString(), {
    max: 2,
    connect_timeout: 3,
    idle_timeout: 20,
    connection: { statement_timeout: 2000, lock_timeout: 1000 },
  })
  return credentialSql
}

export function postgresBambuCloudImportCredentials(
  databaseUrlValue: string,
  master: string,
  endpointFallback: string | undefined,
): BambuCloudImportCredentialSource {
  const sql = credentialDatabase(databaseUrlValue)
  return {
    async load(farmId) {
      try {
        const rows = await sql<
          {
            accessCiphertext: Buffer
            accessNonce: Buffer
            cloudOrigin: string | null
          }[]
        >`
          SELECT access_ciphertext AS "accessCiphertext",
            access_nonce AS "accessNonce",
            cloud_origin AS "cloudOrigin"
          FROM farm.bambu_cloud_accounts
          WHERE farm_id = ${farmId}::uuid`
        const row = rows[0]
        if (!row) return { ok: false, reason: 'not-found' }
        const endpoint = row.cloudOrigin ?? endpointFallback
        if (!endpoint) return { ok: false, reason: 'cloud-rejected' }
        const accessToken = openBambuCloudSecret(
          {
            ciphertext: Buffer.from(row.accessCiphertext),
            nonce: Buffer.from(row.accessNonce),
          },
          master,
        )
        return { ok: true, credentials: { accessToken, endpoint } }
      } catch {
        return { ok: false, reason: 'storage-unavailable' }
      }
    },
  }
}

export async function listImportableBambuCloudPrinters(input: {
  store: BambuCloudAccountStore
  credentials: BambuCloudImportCredentialSource
  actor: { farmId: string; accountId: string }
  policy: unknown
  knownSerials?: Iterable<string> | undefined
  fetchImpl?: typeof fetch | undefined
}): Promise<
  BambuCloudImportPrintersOk | { ok: false; reason: BambuCloudFailure }
> {
  if (!BAMBU_FARM_ID.test(input.actor.farmId))
    return { ok: false, reason: 'invalid-input' }
  const gate = await input.store.member(input.actor)
  if (gate !== 'owner') return { ok: false, reason: gate }
  const loaded = await input.credentials.load(input.actor.farmId)
  if (!loaded.ok) return loaded
  return listBambuCloudAccountPrinters({
    endpoint: loaded.credentials.endpoint,
    accessToken: loaded.credentials.accessToken,
    policy: input.policy,
    ...(input.knownSerials ? { knownSerials: input.knownSerials } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    logger,
    farmId: input.actor.farmId,
  })
}

export async function bambuCloudPrintersHttp(
  event: RequestEvent,
  target: { farmId: string },
  overrides?: {
    store?: BambuCloudAccountStore | undefined
    credentials?: BambuCloudImportCredentialSource | undefined
    fetchImpl?: typeof fetch | undefined
  },
) {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  event.res.headers.set('Cache-Control', 'no-store')
  if (!isBambuCloudEnabled(useRuntimeConfig()))
    throw createError({
      status: 404,
      message: 'Conta Bambu Cloud indisponível.',
    })
  if (!BAMBU_FARM_ID.test(target.farmId)) throw invalid()
  const request = event.req
  const url = new URL(request.url)
  if (request.method !== 'GET') throw invalid()
  const knownSerials = parseKnownSerials(url.searchParams.get('knownSerials'))
  for (const key of url.searchParams.keys()) {
    if (key !== 'knownSerials') throw invalid()
  }
  const auth = authRuntime()
  const { accountId } = await authenticatedSession(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  try {
    if (
      !(await auth.credentials.consumeLimit(
        's',
        `bambu-cloud:printers:${sessionRecordId}`,
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
  let store = overrides?.store
  let credentials = overrides?.credentials
  if (!store || !credentials) {
    try {
      const master = masterKey()
      const dbUrl = databaseUrl()
      store = store ?? bambuCloudDatabaseStore(dbUrl, master)
      credentials =
        credentials ??
        postgresBambuCloudImportCredentials(
          dbUrl,
          master,
          process.env.OPENFARM_BAMBU_CLOUD_ORIGIN,
        )
    } catch {
      return failure('storage-unavailable')
    }
  }
  const result = await listImportableBambuCloudPrinters({
    store,
    credentials,
    actor: { farmId: target.farmId, accountId },
    policy: useRuntimeConfig(),
    ...(knownSerials ? { knownSerials } : {}),
    ...(overrides?.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  })
  if (!result.ok) return failure(result.reason)
  return {
    printers: result.printers,
    skippedMalformed: result.skippedMalformed,
  }
}
