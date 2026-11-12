import { databaseGateBlocks } from '../utils/database/phase.ts'

export default defineEventHandler((event) => {
  // Assumes app.baseURL is '/': the exempt probe paths are matched verbatim.
  if (!databaseGateBlocks(getRequestURL(event).pathname)) return
  // Plain response, not createError: Nuxt's error renderer stays out of the gate.
  setResponseStatus(event, 503)
  setResponseHeader(event, 'retry-after', 5)
  setResponseHeader(event, 'cache-control', 'no-store')
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return 'Serviço indisponível: banco de dados em preparação. Tente novamente.'
})
