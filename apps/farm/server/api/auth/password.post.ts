import { defineEventHandler, createError, getRequestIP } from 'nuxt/server'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import { createLogger } from '@open3dfarmmanager/shared'
import {
  authenticatedSession,
  mutation,
} from '../../services/authenticated-session.ts'
import { parsePasswordChange } from '../../services/password-change.ts'
import { authRuntime } from '../../utils/auth/runtime.ts'
import { sealedSessionRecordId } from '../../services/authenticated-session.ts'
import {
  hashPassword,
  verifyPassword,
  PasswordCapacityError,
} from '../../utils/auth/password.ts'

const logger = createLogger('farm-server')
const failed = () =>
  createError({
    status: 401,
    message:
      'Não foi possível alterar a senha. Confira a senha atual e tente novamente.',
  })

export default defineEventHandler(async (event) => {
  const runtime = authRuntime()
  mutation(event, runtime)
  const auth = await authenticatedSession(event, runtime)
  const sessionId = await sealedSessionRecordId(event, runtime)
  const source =
    getRequestIP(event, { xForwardedFor: false }) ?? 'unknown-source'
  try {
    if (
      !runtime.credentials.findByAccount ||
      !runtime.credentials.replacePassword ||
      !runtime.sessions.revokeOtherSessions
    )
      throw new Error('Password change unavailable')
    if (
      !(await runtime.credentials.consumeLimit('s', source)) ||
      !(await runtime.credentials.consumeLimit('a', auth.accountId))
    )
      throw createError({
        status: 429,
        message: 'Muitas tentativas. Aguarde 15 minutos.',
      })
    if (
      event.req.headers.get('content-type')?.split(';')[0]?.trim() !==
        'application/json' ||
      event.req.headers.has('content-encoding')
    )
      throw createError({ status: 415, message: 'Envie os dados em JSON.' })
    const reader = event.req.body?.getReader()
    if (!reader)
      throw createError({ status: 400, message: 'Dados de senha inválidos.' })
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 4096)
          throw createError({
            status: 413,
            message: 'Solicitação muito grande.',
          })
        chunks.push(chunk.value)
      }
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    let input: unknown
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      )
      input = parseBoundedJson(text, {
        maxBytes: 4096,
        maxDepth: 2,
        maxValues: 3,
        maxStringChars: 1024,
      })
    } catch {
      throw createError({ status: 400, message: 'Dados de senha inválidos.' })
    }
    const { currentPassword, newPassword } = parsePasswordChange(input)
    const credentials = await runtime.credentials.findByAccount(auth.accountId)
    if (
      !credentials ||
      !(await verifyPassword(credentials.passwordHash, currentPassword))
    )
      throw failed()
    const hash = await hashPassword(newPassword)
    if (!(await runtime.credentials.replacePassword(credentials, hash)))
      throw failed()
    await runtime.sessions.revokeOtherSessions(
      auth.accountId,
      sessionId,
      Date.now(),
    )
    return { message: 'Senha alterada. As outras sessões foram encerradas.' }
  } catch (error) {
    if (error instanceof PasswordCapacityError)
      throw createError({
        status: 429,
        message: 'Muitas tentativas. Tente novamente.',
      })
    if (error instanceof Error && ('status' in error || 'statusCode' in error))
      throw error
    logger.error('password-change-failed', { error })
    throw createError({
      status: 503,
      message: 'Não foi possível alterar a senha agora.',
    })
  }
})
