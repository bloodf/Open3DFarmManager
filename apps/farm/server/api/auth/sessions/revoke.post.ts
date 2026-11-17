import { defineEventHandler, createError } from 'nuxt/server'
import {
  authenticatedSession,
  mutation,
} from '../../../services/authenticated-session.ts'
import { authRuntime } from '../../../utils/auth/runtime.ts'

export default defineEventHandler(async (event) => {
  const runtime = authRuntime()
  mutation(event, runtime)
  const { accountId } = await authenticatedSession(event, runtime)
  try {
    await runtime.sessions.revokeAccountSessions(accountId)
    return { message: 'Todas as sessões da conta foram encerradas.' }
  } catch {
    throw createError({
      status: 503,
      message: 'Não foi possível encerrar as sessões agora.',
    })
  }
})
