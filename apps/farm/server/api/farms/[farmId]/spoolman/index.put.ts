import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolmanFarmSetting } from '../../../../services/spoolman-farm-setting.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  return spoolmanFarmSetting(event, 'put', { farmId })
})
