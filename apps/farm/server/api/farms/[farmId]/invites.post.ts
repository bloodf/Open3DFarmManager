import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { createFarmInvite } from '../../../services/account-registration.ts'
import { authRuntime } from '../../../utils/auth/runtime.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  return createFarmInvite(event, authRuntime(), farmId)
})
