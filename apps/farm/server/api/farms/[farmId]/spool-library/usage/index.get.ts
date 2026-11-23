import { defineEventHandler, getRouterParam } from 'nuxt/server'
import {
  spoolUsageFeature,
  usageQuery,
} from '../../../../../services/spool-usage.ts'
export default defineEventHandler((event) =>
  spoolUsageFeature(
    event,
    getRouterParam(event, 'farmId') ?? '',
    'usage-list',
    usageQuery(event.req.url),
  ),
)
