import {
  integrationPath,
  integrationProblem,
  oauthError,
} from '../utils/integration-auth-http.ts'
import { databaseGateBlocks } from '../utils/database/phase.ts'

export default defineEventHandler((event) => {
  // Assumes app.baseURL is '/': the exempt probe paths are matched verbatim.
  const url = getRequestURL(event)
  if (!databaseGateBlocks(url.pathname)) return
  const path = integrationPath(url)
  if (path === '/openapi.json') return
  if (path === '/oauth/token')
    return oauthError('temporarily_unavailable', 503, { 'retry-after': '5' })
  if (path !== null)
    return integrationProblem('service-unavailable', { 'retry-after': '5' })
  // Plain response, not createError: Nuxt's error renderer stays out of the gate.
  setResponseStatus(event, 503)
  setResponseHeader(event, 'retry-after', 5)
  setResponseHeader(event, 'cache-control', 'no-store')
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return 'Serviço indisponível: banco de dados em preparação. Tente novamente.'
})
