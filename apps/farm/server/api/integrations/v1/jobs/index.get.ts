import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../utils/integration-auth-http.ts'
import { integrationAuthPool } from '../../../../utils/integration-auth-runtime.ts'
import {
  uuidPattern,
  type IntegrationPrincipal,
} from '../../../../utils/integration-auth.ts'
import {
  jobGrantScope,
  listIntegrationJobs,
  validJobCursor,
} from '../../../../utils/integration-read.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const query = new URL(event.req.url).searchParams
  const principal = event.context.integrationAuth as IntegrationPrincipal
  const farms = query.getAll('farmId')
  const printers = query.getAll('printerId')
  const sinceValues = query.getAll('since')
  const untilValues = query.getAll('until')
  const limits = query.getAll('limit')
  const cursors = query.getAll('cursor')
  const farmId = farms[0]
  const printerId = printers[0]
  const since = sinceValues[0]
  const until = untilValues[0]
  const limit = limits[0] ?? '50'
  const cursor = cursors[0] ?? null
  if (
    [...query.keys()].some(
      (key) =>
        !['farmId', 'printerId', 'since', 'until', 'limit', 'cursor'].includes(
          key,
        ),
    ) ||
    farms.length > 1 ||
    printers.length > 1 ||
    sinceValues.length > 1 ||
    untilValues.length > 1 ||
    limits.length > 1 ||
    cursors.length > 1 ||
    (farmId !== undefined && !uuidPattern.test(farmId)) ||
    (printerId !== undefined && !uuidPattern.test(printerId)) ||
    (since !== undefined &&
      (!/^(0|[1-9]\d{0,15})$/.test(since) ||
        !Number.isSafeInteger(Number(since)))) ||
    (until !== undefined &&
      (!/^(0|[1-9]\d{0,15})$/.test(until) ||
        !Number.isSafeInteger(Number(until)))) ||
    !/^(?:[1-9]\d?|100)$/.test(limit) ||
    (cursor !== null && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) ||
    !validJobCursor(cursor)
  )
    return integrationProblem('invalid-request', headers)
  const normalizedFarmId = farmId?.toLowerCase()
  const normalizedPrinterId = printerId?.toLowerCase()

  const scope = jobGrantScope(principal, normalizedFarmId, normalizedPrinterId)
  if (!scope.farmWideFarmIds.length && !scope.assignmentIds.length)
    return integrationProblem('not-found', headers)
  try {
    return await listIntegrationJobs(integrationAuthPool(), {
      ...scope,
      appId: principal.appId,
      printerId: normalizedPrinterId ?? null,
      since: since === undefined ? null : Number(since),
      until: until === undefined ? null : Number(until),
      limit: Number(limit),
      cursor,
    })
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
