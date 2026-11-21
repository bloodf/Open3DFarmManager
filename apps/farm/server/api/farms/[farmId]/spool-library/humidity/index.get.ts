import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolFeature } from '../../../../../services/spool-drying.ts'
export default defineEventHandler((event) =>
  spoolFeature(
    event,
    getRouterParam(event, 'farmId') ?? '',
    'humidity-list',
    Object.fromEntries(
      [...new URL(event.req.url).searchParams].map(([k, v]) => [
        k,
        ['spoolId', 'slotIndex'].includes(k) ? Number(v) : v,
      ]),
    ),
  ),
)
