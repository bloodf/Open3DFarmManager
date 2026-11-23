import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolLibraryResource } from '../../../../../services/spool-library-http.ts'

export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  return spoolLibraryResource(event, { farmId, resource: 'filaments' })
})
