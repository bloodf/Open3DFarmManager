import {
  defineEventHandler,
  getQuery,
  getRouterParam,
  useRuntimeConfig,
} from 'nuxt/server'
import { authenticatedSession } from '../../../../services/authenticated-session.ts'
import { listIntegrationAudit } from '../../../../services/integration-audit-http.ts'
import { authRuntime } from '../../../../utils/auth/runtime.ts'
import { integrationAuthPool } from '../../../../utils/integration-auth-runtime.ts'

export default defineEventHandler(async (event) => {
  const farmId = getRouterParam(event, 'farmId') ?? ''
  const auth = authRuntime()
  const { accountId } = await authenticatedSession(event, auth)
  const query = getQuery(event)
  const config = useRuntimeConfig().integrationAuth
  return listIntegrationAudit({
    accountId,
    farmId,
    query: {
      appId: typeof query.appId === 'string' ? query.appId : undefined,
      printerId:
        typeof query.printerId === 'string' ? query.printerId : undefined,
      before: typeof query.before === 'string' ? query.before : undefined,
    },
    pool: integrationAuthPool(),
    rateLimitConfig: {
      read: config.readLimit,
      write: config.writeLimit,
    },
    setHeaders: (headers) => {
      for (const [name, value] of Object.entries(headers))
        event.res.headers.set(name, value)
    },
  })
})
