import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolFinderScan } from '../../../utils/spool-library/finder-http.ts'

export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  return spoolFinderScan(event, farmId)
})
