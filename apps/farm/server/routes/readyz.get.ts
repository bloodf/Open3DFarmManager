import { currentDatabaseReadiness } from '../utils/database/runtime.ts'

export default defineEventHandler(async (event) => {
  const database = (await currentDatabaseReadiness()) ?? 'disabled'
  const ready = database === 'ok' || database === 'disabled'
  setResponseStatus(event, ready ? 200 : 503)
  setResponseHeader(event, 'cache-control', 'no-store')
  return { status: ready ? 'ok' : 'unavailable', checks: { database } }
})
