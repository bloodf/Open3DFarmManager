import { createError, getRouterParam, type RequestEvent } from 'nuxt/server'
import {
  authenticatedSession,
  limit,
  mutation,
} from './authenticated-session.ts'
import { authRuntime } from '../utils/auth/runtime.ts'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import { parseSignInRules } from '../storage/sign-in-rules.ts'

const notFound = () =>
  createError({ status: 404, message: 'Recurso não encontrado.' })
const invalid = () =>
  createError({ status: 400, message: 'Regras de acesso inválidas.' })
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export async function signInRulesRoute(event: RequestEvent, write: boolean) {
  const runtime = authRuntime()
  const farmId = getRouterParam(event, 'farmId') ?? ''
  if (!uuid.test(farmId) || !runtime.signInRules) throw notFound()
  event.res.headers.set('Cache-Control', 'no-store')
  if (write) mutation(event, runtime)
  else {
    const origin = event.req.headers.get('origin')
    if (origin && !checkMutationOrigin(origin, runtime.origin).ok)
      throw createError({ status: 403, message: 'Origem não permitida.' })
  }
  const { accountId } = await authenticatedSession(event, runtime)
  await limit(runtime, 'a', 'sign-in-rules:' + accountId)
  let rules
  if (write) {
    if (
      event.req.headers.get('content-type')?.split(';')[0]?.trim() !==
        'application/json' ||
      event.req.headers.has('content-encoding')
    )
      throw createError({ status: 415, message: 'Envie os dados em JSON.' })
    try {
      const text = await event.req.text()
      if (text.length > 30000) throw invalid()
      rules = parseSignInRules(JSON.parse(text))
    } catch {
      throw invalid()
    }
    if (!rules) throw invalid()
  }
  const result = await runtime.signInRules.access(accountId, farmId, rules)
  if (!result) throw notFound()
  return { rules: result }
}
