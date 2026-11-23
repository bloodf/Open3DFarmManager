import { createError, defineEventHandler } from 'nuxt/server'
import { authenticatedSession } from '../services/authenticated-session.ts'
import { authRuntime } from '../utils/auth/runtime.ts'
import { readText } from '../utils/integration-auth-http.ts'
import {
  integrationAuthPool,
  integrationAuthRuntime,
} from '../utils/integration-auth-runtime.ts'
import { cameraEnabled } from '../utils/integration-telemetry-camera.ts'

export default defineEventHandler(async (event) => {
  const auth = authRuntime()
  if (event.req.headers.get('origin') !== auth.origin)
    throw createError({ status: 403, message: 'Origem não permitida.' })
  const { accountId } = await authenticatedSession(event, auth)
  event.res.headers.set('referrer-policy', 'no-referrer')
  const missing = () =>
    createError({ status: 404, message: 'Câmera indisponível.' })
  let ticket: string
  try {
    ticket = await readText(event.req, 512)
  } catch {
    throw missing()
  }
  const printer = await integrationAuthRuntime().redeemCameraTicket(ticket)
  if (!printer) throw missing()
  const sql = integrationAuthPool()
  const [membership] = await sql`SELECT 1 FROM farm.memberships
    WHERE farm_id = ${printer.farmId}::uuid AND account_id = ${accountId}
      AND revoked_at IS NULL`
  if (!membership || !(await cameraEnabled(sql, printer))) throw missing()
  return { farmId: printer.farmId, printerId: printer.id }
})
