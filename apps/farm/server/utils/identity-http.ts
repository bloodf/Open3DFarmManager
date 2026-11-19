import { createError, type RequestEvent } from 'nuxt/server'
import {
  authResponse,
  authenticatedSession,
  limit,
  mutation,
} from '../services/authenticated-session.ts'
import { authRuntime, type AuthRuntime } from './auth/runtime.ts'
import { GOOGLE_PROVIDER_PRESET } from './google-provider-preset.ts'
import { accountIdentitiesView, canUnlinkGoogle } from './identity-google.ts'
import type { PostgresIdentities } from '../storage/postgres-identities.ts'

type AuthEvent = Pick<RequestEvent, 'req' | 'res'>

function identities(runtime: AuthRuntime): PostgresIdentities {
  if (!runtime.identities)
    throw createError({ status: 503, message: 'Autenticação indisponível.' })
  return runtime.identities
}

export async function listAccountIdentities(event: AuthEvent) {
  const runtime = authRuntime()
  authResponse(event)
  const auth = await authenticatedSession(event, runtime)
  const methods = await identities(runtime).accountSignInMethods(auth.accountId)
  if (!methods)
    throw createError({ status: 404, message: 'Conta indisponível.' })
  const googleStatus = runtime.signInProviders
    ? await runtime.signInProviders.publicStatus()
    : { enabled: false as const }
  const googleAvailable = googleStatus.enabled === true
  return accountIdentitiesView({
    googleAvailable,
    googleLinked: methods.googleLinked,
    canUnlinkGoogle: canUnlinkGoogle(methods),
  })
}

export async function unlinkGoogleIdentity(event: AuthEvent) {
  const runtime = authRuntime()
  mutation(event, runtime)
  const auth = await authenticatedSession(event, runtime)
  await limit(runtime, 'a', 'identity-unlink:' + auth.accountId)
  const methods = await identities(runtime).accountSignInMethods(auth.accountId)
  if (!methods)
    throw createError({ status: 404, message: 'Conta indisponível.' })
  if (!canUnlinkGoogle(methods))
    throw createError({
      status: 409,
      message:
        'Mantenha outra forma de entrada (senha ou outro provedor vinculado) antes de desvincular o Google.',
    })
  const result = await identities(runtime).unlink(
    auth.accountId,
    GOOGLE_PROVIDER_PRESET.issuer,
  )
  switch (result) {
    case 'unlinked':
      return { message: 'Conta Google desvinculada.' }
    case 'not-linked':
      throw createError({
        status: 404,
        message: 'Nenhuma conta Google vinculada.',
      })
    case 'last-method':
      throw createError({
        status: 409,
        message:
          'Mantenha outra forma de entrada (senha ou outro provedor vinculado) antes de desvincular o Google.',
      })
    case 'unavailable':
    case 'rejected':
      throw createError({
        status: 503,
        message: 'Não foi possível desvincular o Google agora.',
      })
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}
