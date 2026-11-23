import { defineEventHandler } from 'nuxt/server'
import {
  integrationGrantFor,
  integrationProblem,
} from '../../../../utils/integration-auth-http.ts'
import {
  integrationAuthPool,
  integrationAuthRuntime,
} from '../../../../utils/integration-auth-runtime.ts'
import {
  uuidPattern,
  type IntegrationPrincipal,
} from '../../../../utils/integration-auth.ts'
import { authorizedPrinter } from '../../../../utils/integration-telemetry.ts'
import { cameraEnabled } from '../../../../utils/integration-telemetry-camera.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  headers.set('cache-control', 'no-store')
  if (new URL(event.req.url).searchParams.size)
    return integrationProblem('invalid-request', headers)
  const printerId = (event.context.params?.id ?? '').toLowerCase()
  if (!uuidPattern.test(printerId))
    return integrationProblem('not-found', headers)
  try {
    const auth = integrationAuthRuntime()
    if (!auth.store.readPrinter)
      return integrationProblem('service-unavailable', headers)
    const principal = event.context.integrationAuth as IntegrationPrincipal
    const printer = authorizedPrinter(
      principal,
      await auth.store.readPrinter(printerId),
      printerId,
      'camera:view',
    )
    if (!printer) return integrationProblem('not-found', headers)
    const grant = integrationGrantFor(
      principal,
      'camera:view',
      printer.farmId,
      printer.id,
    )
    if (!grant || !(await cameraEnabled(integrationAuthPool(), printer)))
      return integrationProblem('not-found', headers)
    return auth.issueCameraLink(principal.appId, printer.id, grant.id)
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
