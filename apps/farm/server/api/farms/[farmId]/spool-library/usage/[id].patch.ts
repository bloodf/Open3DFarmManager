import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolUsageFeature } from '../../../../../services/spool-usage.ts'
/** Correct a record: { grams }. The spool's used weight moves by the difference. */
export default defineEventHandler((event) =>
  spoolUsageFeature(
    event,
    getRouterParam(event, 'farmId') ?? '',
    'usage-correct',
    {
      id: getRouterParam(event, 'id') ?? '',
    },
  ),
)
