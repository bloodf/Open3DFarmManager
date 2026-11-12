import { currentDatabaseReadiness } from '../utils/database/runtime.ts'
import { readinessHttp } from '../utils/database/schema.ts'

export default defineEventHandler(async (event) => {
  const { status, body } = readinessHttp(await currentDatabaseReadiness())
  setResponseStatus(event, status)
  setResponseHeader(event, 'cache-control', 'no-store')
  return body
})
