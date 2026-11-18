import type { IntegrationPrincipal } from './integration-auth.ts'
import { integrationBase, integrationProblem } from './integration-auth-http.ts'
import {
  IDEMPOTENCY_KEY_PATTERN,
  type IntegrationJobsService,
} from '../services/integration-jobs.ts'

const MAX_BODY_BYTES = 16 * 1024

class TooLarge extends Error {}

async function readJson(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) throw new SyntaxError('empty')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > MAX_BODY_BYTES) throw new TooLarge()
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(text) as unknown
}

/**
 * Handles an authorized `POST /printers/{id}/jobs`. `headers` are the rate
 * limit headers the middleware already computed for this request.
 */
export async function submitIntegrationJobRequest(
  request: Request,
  principal: IntegrationPrincipal,
  printerId: string,
  service: IntegrationJobsService,
  headers?: HeadersInit,
) {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    return integrationProblem('unsupported-media-type', headers)
  const key = request.headers.get('idempotency-key')
  if (key === null || !IDEMPOTENCY_KEY_PATTERN.test(key))
    return integrationProblem('invalid-request', headers)
  let body: unknown
  try {
    body = await readJson(request)
  } catch (error) {
    return integrationProblem(
      error instanceof TooLarge ? 'payload-too-large' : 'invalid-request',
      headers,
    )
  }
  try {
    const result = await service.submit(principal, printerId, key, body)
    if (!result.ok) return integrationProblem(result.problem, headers)
    const responseHeaders = new Headers(headers)
    responseHeaders.set('cache-control', 'no-store')
    responseHeaders.set('location', `${integrationBase}/jobs/${result.job.id}`)
    return Response.json(result.job, { status: 202, headers: responseHeaders })
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}

export async function getIntegrationJobRequest(
  principal: IntegrationPrincipal,
  jobId: string,
  service: IntegrationJobsService,
  headers?: HeadersInit,
) {
  try {
    const result = await service.get(principal, jobId)
    if ('error' in result) return integrationProblem(result.error, headers)
    return Response.json(result, {
      headers: {
        ...Object.fromEntries(new Headers(headers)),
        'cache-control': 'no-store',
      },
    })
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}
