import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { libraryRoutes } from '../../../../../utils/library/routes.ts'
export default defineEventHandler((event) =>
  libraryRoutes(event, 'get', {
    farmId: getRouterParam(event, 'farmId') ?? '',
    versionId: getRouterParam(event, 'versionId') ?? '',
  }),
)
