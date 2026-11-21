import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolUsageFeature } from '../../../../../services/spool-usage.ts'
/** Manual or API usage: { spoolId, grams, jobId?, printerId?, source? }. */
export default defineEventHandler((event) =>
  spoolUsageFeature(
    event,
    getRouterParam(event, 'farmId') ?? '',
    'usage-record',
  ),
)
