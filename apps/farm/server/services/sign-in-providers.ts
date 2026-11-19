import { createError, type RequestEvent } from 'nuxt/server'
import {
  authenticatedSession,
  limit,
  mutation,
} from './authenticated-session.ts'
import { authRuntime } from '../utils/auth/runtime.ts'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import { parseGoogleProviderWrite } from '../utils/google-provider-preset.ts'

const notFound = () =>
  createError({ status: 404, message: 'Recurso não encontrado.' })
const invalid = () =>
  createError({ status: 400, message: 'Configuração do provedor inválida.' })

export async function signInProvidersGet(event: RequestEvent) {
  const runtime = authRuntime()
  if (!runtime.signInProviders) throw notFound()
  event.res.headers.set('Cache-Control', 'no-store')
  const origin = event.req.headers.get('origin')
  if (origin && !checkMutationOrigin(origin, runtime.origin).ok)
    throw createError({ status: 403, message: 'Origem não permitida.' })
  const { accountId } = await authenticatedSession(event, runtime)
  await limit(runtime, 'a', 'sign-in-providers:' + accountId)
  const provider = await runtime.signInProviders.adminGet(
    accountId,
    runtime.origin,
  )
  if (!provider) throw notFound()
  return { providers: [provider] }
}

export async function signInProvidersGooglePut(event: RequestEvent) {
  const runtime = authRuntime()
  if (!runtime.signInProviders) throw notFound()
  mutation(event, runtime)
  event.res.headers.set('Cache-Control', 'no-store')
  const { accountId } = await authenticatedSession(event, runtime)
  await limit(runtime, 'a', 'sign-in-providers:' + accountId)
  if (
    event.req.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json' ||
    event.req.headers.has('content-encoding')
  )
    throw createError({ status: 415, message: 'Envie os dados em JSON.' })
  let body: unknown
  try {
    const text = await event.req.text()
    if (text.length > 4000) throw invalid()
    body = JSON.parse(text)
  } catch {
    throw invalid()
  }
  const parsed = parseGoogleProviderWrite(body)
  if (!parsed.ok) throw invalid()
  const current = await runtime.signInProviders.adminGet(
    accountId,
    runtime.origin,
  )
  if (!current) throw notFound()
  if (
    parsed.enabled &&
    parsed.clientSecret === undefined &&
    !current.hasClientSecret
  )
    throw invalid()
  const update: {
    enabled: boolean
    clientId: string
    clientSecret?: string
  } = { enabled: parsed.enabled, clientId: parsed.clientId }
  if (parsed.clientSecret !== undefined)
    update.clientSecret = parsed.clientSecret
  const provider = await runtime.signInProviders.adminPut(
    accountId,
    runtime.origin,
    update,
  )
  if (!provider) throw invalid()
  return { provider }
}
