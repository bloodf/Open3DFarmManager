import { signallingRuntime } from '../services/signalling-runtime-bootstrap.ts'
import { integrationProblem } from './integration-auth-http.ts'
import {
  integrationAuthPool,
  integrationAuthRuntime,
} from './integration-auth-runtime.ts'
import { PostgresFleetMode } from '../storage/fleet-mode-postgres.ts'
import { uuidPattern, type IntegrationPrincipal } from './integration-auth.ts'
import { integrationJobsRuntime } from './integration-jobs-runtime.ts'

export async function readIntegrationDispatch(input: {
  request: Request
  headers: HeadersInit
  principal: IntegrationPrincipal
  jobId: string
  view: 'eligibility' | 'plate'
}) {
  const { request, headers, principal, jobId, view } = input
  const printerIds = new URL(request.url).searchParams.getAll('printerId')
  if (printerIds.length !== 1 || !uuidPattern.test(printerIds[0]!))
    return integrationProblem('invalid-request', headers)
  const printerId = printerIds[0]!
  try {
    const { service } = await integrationJobsRuntime()
    const job = await service.get(principal, jobId)
    if ('error' in job) return integrationProblem(job.error, headers)
    if (job.printerId !== printerId)
      return integrationProblem('not-found', headers)
    const store = integrationAuthRuntime().store
    const printer = await store.readPrinter?.(printerId)
    if (!printer || printer.farmId !== job.farmId)
      return integrationProblem('not-found', headers)
    const inbox = signallingRuntime()
    if (!inbox || !printer.agentId)
      return integrationProblem('connector-unavailable', headers)
    const result = await inbox.queryAgentInbox(
      job.farmId,
      printer.agentId,
      {
        assignment_id: printerId,
        kind: 'dispatch',
        limit: 1,
        offset: 0,
      },
      request.signal,
    )
    if (result.kind === 'error')
      return integrationProblem(result.error, headers)
    if (result.kind !== 'dispatch')
      return integrationProblem('connector-unavailable', headers)
    const { printerState, plateState, observedAt, attemptId } = result.data[0]
    const plate = {
      state: plateState,
      observedAt,
      ...(attemptId ? { attemptId } : {}),
    }
    const reasons: string[] = []
    if (
      view === 'eligibility' &&
      (await new PostgresFleetMode(integrationAuthPool()).read(printerId))
        ?.mode === 'maintenance'
    )
      reasons.push('maintenance')
    if (job.status !== 'held' && job.status !== 'queued')
      reasons.push('job-not-pending')
    if (printerState !== 'idle')
      reasons.push(
        printerState === 'busy' ? 'printer-busy' : 'printer-not-ready',
      )
    if (plateState !== 'operator-confirmed')
      reasons.push(
        plateState === 'unknown' ? 'plate-state-uncertain' : plateState,
      )
    const responseHeaders = new Headers(headers)
    responseHeaders.set('cache-control', 'no-store')
    return Response.json(
      {
        jobId: job.id,
        printerId,
        plate,
        ...(view === 'eligibility'
          ? { eligible: reasons.length === 0, reasons }
          : {}),
      },
      { headers: responseHeaders },
    )
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}
