import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolUsageFeature } from '../../../../../services/spool-usage.ts'
/** Farm defaults: { defaultLowStockThresholdGrams?: number | null, currency?: 'USD' }. */
export default defineEventHandler((event) =>
  spoolUsageFeature(
    event,
    getRouterParam(event, 'farmId') ?? '',
    'settings-set',
  ),
)
