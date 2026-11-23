import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolLibraryImport } from '../../../../services/spool-library-import.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  return spoolLibraryImport(event, { farmId })
})
