import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { libraryRoutes } from '../../../../../../utils/library/routes.ts'
export default defineEventHandler((event) =>
  libraryRoutes(event, 'versions', {
    farmId: getRouterParam(event, 'farmId') ?? '',
    itemId: getRouterParam(event, 'itemId') ?? '',
  }),
)
