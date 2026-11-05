import { createError, defineEventHandler } from 'nuxt/server'
import { authenticatedSession } from '../../services/authenticated-session.ts'
import { authRuntime } from '../../utils/auth/runtime.ts'
import { connectorPairingRuntime } from '../../utils/connector-pairing/runtime.ts'
export default defineEventHandler(async (event) => {
  const auth = authRuntime()
  await authenticatedSession(event, auth)
  const pairing = await connectorPairingRuntime()
  if (pairing.origin !== auth.origin)
    throw createError({ status: 503, message: 'Pareamento indisponível.' })
  return { enabled: true }
})
