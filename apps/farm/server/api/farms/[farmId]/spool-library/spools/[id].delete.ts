import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolLibraryResource } from '../../../../../services/spool-library-http.ts'

export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  const id = getRouterParam(event, 'id')
  if (!farmId || !id)
    throw createError({ status: 400, message: 'Solicitação inválida.' })
  return spoolLibraryResource(event, { farmId, resource: 'spools', id })
})
