import { createError, defineEventHandler } from 'nuxt/server'
import {
  configurationAuthorityRequest,
  configurationBootstrapRequest,
  configurationReceiptRequest,
} from '../services/configuration-http.ts'
import { authResponse } from '../services/authenticated-session.ts'
import {
  configurationHttpRuntime,
  configurationIssuerMetadata,
} from '../utils/configuration/runtime.ts'

const uuid = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
const authority = /^\/api\/configuration-authority\/(challenges|capabilities)$/
const receipts = new RegExp(`^/api/farms/${uuid}/configuration-receipts$`)
const bootstrap = new RegExp(
  `^/api/farms/${uuid}/connectors/${uuid}/configuration$`,
)

/**
 * config-v1 HTTP endpoints. They are dispatched here, after the database gate
 * (00.*), by exact path only; every other request falls through untouched.
 * Without an installed configuration runtime each of them answers 404.
 *
 *   POST /api/configuration-authority/challenges
 *   POST /api/configuration-authority/capabilities
 *   POST /api/farms/:farmId/configuration-receipts
 *   GET  /api/farms/:farmId/connectors/:agentId/configuration?keyId=:keyId
 */
export default defineEventHandler((event) => {
  const path = new URL(event.req.url).pathname
  if (path === '/api/configuration-authority/issuer') {
    authResponse(event)
    if (event.req.method !== 'GET')
      throw createError({ status: 405, message: 'Método não permitido.' })
    if (new URL(event.req.url).search)
      throw createError({ status: 400, message: 'Solicitação inválida.' })
    return configurationIssuerMetadata()
  }
  const operation = authority.exec(path)?.[1]
  const receipt = receipts.exec(path)
  const metadata = bootstrap.exec(path)
  if (!operation && !receipt && !metadata) return
  authResponse(event)
  const runtime = configurationHttpRuntime()
  if (operation === 'challenges' || operation === 'capabilities')
    return configurationAuthorityRequest(event, runtime, operation)
  if (receipt?.[1])
    return configurationReceiptRequest(event, runtime, { farmId: receipt[1] })
  if (metadata?.[1] && metadata[2])
    return configurationBootstrapRequest(event, runtime, {
      farmId: metadata[1],
      agentId: metadata[2],
    })
})
