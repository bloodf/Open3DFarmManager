import { databaseGateBlocks } from '../utils/database/phase.ts'

export default defineEventHandler((event) => {
  if (!databaseGateBlocks(getRequestURL(event).pathname)) return
  setResponseHeader(event, 'retry-after', 5)
  setResponseHeader(event, 'cache-control', 'no-store')
  throw createError({
    status: 503,
    message:
      'Serviço indisponível: banco de dados em preparação. Tente novamente.',
  })
})
