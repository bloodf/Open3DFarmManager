import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolFeature } from '../../../../../../services/spool-drying.ts'
export default defineEventHandler((event) =>
  spoolFeature(event, getRouterParam(event, 'farmId') ?? '', 'spool', {
    spoolId: Number(getRouterParam(event, 'spoolId')),
  }),
)
