import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { libraryRoutes } from '../../../../utils/library/routes.ts'
export default defineEventHandler((event) =>
  libraryRoutes(event, 'replay-source', {
    farmId: getRouterParam(event, 'farmId') ?? '',
  }),
)
