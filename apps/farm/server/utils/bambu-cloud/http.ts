import { credentialKeyring } from '../sealed-credential-key.ts'
import { createLogger } from '@open3dfarmmanager/shared'
import { createError, useRuntimeConfig, type RequestEvent } from 'nuxt/server'
import { isBambuCloudEnabled } from '../../../../../packages/connector/src/bambu/cloud.ts'
import { readPrinterAssignmentBody } from '../../services/printer-assignments.ts'
import {
  authenticatedSession,
  authResponse,
  sealedSessionRecordId,
} from '../../services/authenticated-session.ts'
import { checkMutationOrigin } from '../auth/boundary.ts'
import { authRuntime } from '../auth/runtime.ts'
import {
  BAMBU_FARM_ID,
  connectBambuCloudAccount,
  disconnectBambuCloudAccount,
  readBambuCloudAccount,
  type BambuCloudConnectResult,
  type BambuCloudFailure,
} from './account.ts'
import { bambuCloudDatabaseStore } from './postgres.ts'

const logger = createLogger('bambu-cloud')

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
      message: 'Apenas o proprietário conecta a conta Bambu Cloud.',
    })
  if (reason === 'cloud-unauthorized')
    throw createError({
      status: 422,
      message: 'A nuvem Bambu recusou o código, a senha ou o token.',
    })
  if (reason === 'cloud-rejected')
    throw createError({
      status: 422,
      message: 'Não foi possível falar com a nuvem Bambu local.',
    })
  throw createError({
    status: 503,
    message: 'Conta Bambu Cloud indisponível. Tente novamente.',
  })
}

function view(result: BambuCloudConnectResult) {
  if (!result.ok) return failure(result.reason)
  if ('tfaRequired' in result)
    return { tfaRequired: true, tfaKey: result.tfaKey }
  return result.account
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
  return credentialKeyring(auth)
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

export async function bambuCloudAccountHttp(
  event: RequestEvent,
  operation: 'get' | 'post' | 'delete',
  target: { farmId: string },
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
  if (new URL(request.url).search) throw invalid()
  const auth = authRuntime()
  if (operation !== 'get') {
    if (
      request.method !== (operation === 'post' ? 'POST' : 'DELETE') ||
      !checkMutationOrigin(request.headers.get('origin'), auth.origin).ok
    )
      throw createError({
        status: 403,
        message: 'Origem da solicitação não permitida.',
      })
  } else if (request.method !== 'GET') throw invalid()
  if (operation === 'post') {
    if (
      request.headers.get('content-type')?.split(';')[0]?.trim() !==
        'application/json' ||
      request.headers.has('content-encoding')
    )
      throw createError({ status: 415, message: 'Envie os dados em JSON.' })
    const length = request.headers.get('content-length')
    if (
      length !== null &&
      (!/^\d{1,6}$/.test(length) || Number(length) > 16384)
    )
      throw createError({ status: 413, message: 'Solicitação muito grande.' })
  }
  const { accountId } = await authenticatedSession(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  try {
    if (
      !(await auth.credentials.consumeLimit(
        's',
        `bambu-cloud:${operation}:${sessionRecordId}`,
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
  let store
  try {
    store = bambuCloudDatabaseStore(databaseUrl(), masterKey())
  } catch {
    return failure('storage-unavailable')
  }
  const deps = {
    now: new Date(),
    logger,
    policy: useRuntimeConfig(),
    endpointFallback: process.env.OPENFARM_BAMBU_CLOUD_ORIGIN,
  }
  const actor = { farmId: target.farmId, accountId }
  if (operation === 'get')
    return view(await readBambuCloudAccount(store, actor, deps))
  if (operation === 'delete')
    return view(await disconnectBambuCloudAccount(store, actor, deps))
  const body = await readPrinterAssignmentBody(request, {
    maxBytes: 16384,
    maxValues: 16,
  })
  return view(await connectBambuCloudAccount(store, actor, body, deps))
}
