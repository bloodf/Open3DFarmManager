import { defineEventHandler } from 'nuxt/server'
import {
  inspectTelemetryRequest,
  telemetryNodeRequest,
} from '../../../services/telemetry-http-boundary.ts'
import { telemetryHttpRuntime } from '../../../services/telemetry-http-runtime.ts'
export default defineEventHandler(async (event) => {
  event.res.headers.set('Cache-Control', 'no-store')
  try {
    inspectTelemetryRequest(telemetryNodeRequest(event))
  } catch {
    event.res.status = 400
    return { error: 'Solicitação inválida.' }
  }
  const handler = telemetryHttpRuntime()
  if (!handler) {
    event.res.status = 503
    return { error: 'Telemetria indisponível.' }
  }
  const response = await handler(event)
  event.res.status = response.status
  return response.body
})
