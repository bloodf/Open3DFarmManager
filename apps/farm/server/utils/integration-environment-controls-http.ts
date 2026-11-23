import {
  integrationBase,
  integrationProblem,
  PayloadTooLarge,
  readText,
} from './integration-auth-http.ts'
import type { IntegrationPrincipal } from './integration-auth.ts'
import {
  getEnvironmentControlAction,
  listIntegrationEnvironmentControls,
  submitEnvironmentControlAction,
  type EnvironmentControlDeps,
  type EnvironmentControlPorts,
} from './integration-environment-controls.ts'
import type { IntegrationPrinterReader } from './integration-printers.ts'
import { IDEMPOTENCY_KEY_PATTERN } from '../services/integration-jobs.ts'

const MAX_BODY_BYTES = 4 * 1024

export async function listEnvironmentControlsRequest(
  principal: IntegrationPrincipal,
  reader: Pick<IntegrationPrinterReader, 'readPrinters'>,
  query: URLSearchParams,
  headers?: HeadersInit,
  now?: number,
) {
  try {
    const result = await listIntegrationEnvironmentControls(
      principal,
      reader,
      query,
      now,
    )
    if ('error' in result && result.error)
      return integrationProblem(result.error, headers)
    return result
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}

export async function submitEnvironmentControlRequest(
  request: Request,
  principal: IntegrationPrincipal,
  printerId: string,
  deps: EnvironmentControlDeps,
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
    body = JSON.parse(await readText(request, MAX_BODY_BYTES))
  } catch (error) {
    return integrationProblem(
      error instanceof PayloadTooLarge
        ? 'payload-too-large'
        : 'invalid-request',
      headers,
    )
  }
  try {
    const result = await submitEnvironmentControlAction(
      principal,
      printerId,
      key,
      body,
      deps,
    )
    if (!result.ok)
      return integrationProblem(
        result.problem,
        headers,
        undefined,
        result.managementUrl ? { managementUrl: result.managementUrl } : {},
      )
    const responseHeaders = new Headers(headers)
    responseHeaders.set('cache-control', 'no-store')
    responseHeaders.set(
      'location',
      `${integrationBase}/environment/controls/${result.action.printerId}/actions/${result.action.id}`,
    )
    return Response.json(result.action, {
      status: 202,
      headers: responseHeaders,
    })
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}

export async function getEnvironmentControlRequest(
  principal: IntegrationPrincipal,
  printerId: string,
  actionId: string,
  ports: EnvironmentControlPorts | null,
  headers?: HeadersInit,
) {
  try {
    const result = await getEnvironmentControlAction(
      principal,
      printerId,
      actionId,
      ports,
    )
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
