import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
} from 'nuxt/server'
import { z } from 'zod'
import {
  authenticatedSession,
  authResponse,
  mutation,
  sealedSessionRecordId,
} from '../../../../../services/authenticated-session.ts'
import { authRuntime } from '../../../../../utils/auth/runtime.ts'
import { spoolLibraryRuntime } from '../../../../../utils/spool-library/runtime.ts'

const bodySchema = z.strictObject({
  label: z.string().trim().min(1).max(64),
  access: z.enum(['read', 'write']),
})

export default defineEventHandler(async (event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  const auth = authRuntime()
  authResponse(event)
  mutation(event, auth)
  await authenticatedSession(event, auth)
  const body = bodySchema.safeParse(await readBody(event))
  if (!body.success)
    throw createError({
      status: 400,
      message: 'Dados da credencial inválidos.',
    })
  const result = await (
    await spoolLibraryRuntime()
  ).issueLegacyCredential({
    sessionRecordId: await sealedSessionRecordId(event, auth),
    policy: { idleTimeoutMs: auth.idleTimeoutMs },
    farmId,
    label: body.data.label,
    access: body.data.access,
  })
  if (!result.ok)
    throw createError({
      status:
        result.reason === 'denied'
          ? 403
          : result.reason === 'forbidden'
            ? 404
            : 400,
      message:
        result.reason === 'denied'
          ? 'Apenas proprietários e administradores podem criar credenciais.'
          : 'Não foi possível criar a credencial.',
    })
  return result.value
})
