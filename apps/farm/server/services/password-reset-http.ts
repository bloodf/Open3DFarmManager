import { createError, getRequestIP, type RequestEvent } from 'nuxt/server'
import { authResponse, readLoginBody } from './authenticated-session.ts'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import { passwordResetRuntime } from '../utils/auth/password-reset-runtime.ts'
import { completePasswordReset } from './password-reset.ts'

type ResetEvent = Pick<RequestEvent, 'req' | 'res' | 'context'>
export async function passwordResetHttp(event: ResetEvent, complete: boolean) {
  authResponse(event)
  const runtime = passwordResetRuntime(event.context.passwordReset)
  if (
    !checkMutationOrigin(event.req.headers.get('origin'), runtime.auth.origin)
      .ok
  )
    throw createError({
      status: 403,
      message: 'Origem da solicitação não permitida.',
    })
  const unavailable = () =>
    createError({
      status: 503,
      message: 'Redefinição indisponível. Tente novamente.',
    })
  async function limit(kind: 'a' | 's', key: string) {
    let allowed: boolean
    try {
      allowed = await runtime.auth.credentials.consumeLimit(
        kind,
        'reset:' + key,
      )
    } catch {
      throw unavailable()
    }
    if (!allowed)
      throw createError({
        status: 429,
        message: 'Muitas tentativas. Aguarde 15 minutos.',
      })
  }
  await limit(
    's',
    getRequestIP(event, { xForwardedFor: false }) ?? 'unknown-source',
  )
  // Reuse the bounded JSON and password boundary. Requests use a fixed non-secret
  // placeholder; completion supplies the new password. Neither is persisted here.
  const input = await readLoginBody(event.req)
  await limit('a', input.username)
  try {
    if (complete) {
      const token = event.req.headers.get('x-password-reset-token') ?? ''
      if (!(await completePasswordReset({ ...input, token }, runtime.store)))
        throw createError({
          status: 400,
          message:
            'Não foi possível redefinir a senha. Solicite um novo código.',
        })
      return { message: 'Senha redefinida. Entre novamente.' }
    }
    // Identical admission for known, unknown and disabled accounts. Saturation
    // also retains the generic response; no account-dependent work is awaited.
    runtime.queue.enqueue(input.username)
    return {
      message:
        'Se a conta puder receber instruções, elas serão enviadas pelo canal cadastrado.',
    }
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    throw unavailable()
  }
}
