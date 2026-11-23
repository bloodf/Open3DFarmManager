import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolFeature } from '../../../../../services/spool-drying.ts'
export default defineEventHandler((event) =>
  spoolFeature(event, getRouterParam(event, 'farmId') ?? '', 'labels', {
    spoolIds: (new URL(event.req.url).searchParams.get('spoolIds') ?? '')
      .split(',')
      .map(Number),
  }),
)
