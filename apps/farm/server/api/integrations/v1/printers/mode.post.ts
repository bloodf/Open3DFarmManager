import { defineEventHandler } from 'nuxt/server'
import { PostgresFleetMode } from '../../../../storage/fleet-mode-postgres.ts'
import {
  integrationProblem,
  PayloadTooLarge,
  readText,
} from '../../../../utils/integration-auth-http.ts'
import {
  integrationAuthPool,
  integrationAuthRuntime,
} from '../../../../utils/integration-auth-runtime.ts'
import type { IntegrationPrincipal } from '../../../../utils/integration-auth.ts'
import {
  changeFleetMode,
  fleetModeRequest,
} from '../../../../utils/integration-fleet-mode.ts'

export default defineEventHandler(async (event) => {
  const {
    req,
    res: { headers },
  } = event
  if (
    req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json' ||
    req.headers.has('content-encoding')
  )
    return integrationProblem('unsupported-media-type', headers)

  let body: unknown
  try {
    body = JSON.parse(await readText(req, 8192))
  } catch (error) {
    return integrationProblem(
      error instanceof PayloadTooLarge
        ? 'payload-too-large'
        : 'invalid-request',
      headers,
    )
  }
  const parsed = fleetModeRequest.safeParse(body)
  if (!parsed.success) return integrationProblem('invalid-request', headers)

  const principal = event.context.integrationAuth as IntegrationPrincipal
  try {
    const reader = integrationAuthRuntime().store
    const readPrinter = reader.readPrinter?.bind(reader)
    if (!readPrinter) return integrationProblem('service-unavailable', headers)
    // Complete reads before reserving a connection for the write transaction.
    const printers = new Map(
      await Promise.all(
        parsed.data.targets.map(
          async ({ printerId }) =>
            [printerId, await readPrinter(printerId)] as const,
        ),
      ),
    )
    const result = await integrationAuthPool().begin((tx) =>
      changeFleetMode(
        principal,
        async (id) => printers.get(id) ?? null,
        new PostgresFleetMode(tx),
        parsed.data,
      ),
    )
    if (!result) return integrationProblem('not-found', headers)
    headers.set('cache-control', 'no-store')
    return result
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
