import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolUsageFeature } from '../../../../../services/spool-usage.ts'
export default defineEventHandler((event) =>
  spoolUsageFeature(
    event,
    getRouterParam(event, 'farmId') ?? '',
    'settings-get',
  ),
)
