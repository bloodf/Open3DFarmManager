import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolUsageFeature } from '../../../../../../services/spool-usage.ts'
const filamentId = (value: string | undefined) =>
  /^[1-9]\d{0,15}$/.test(value ?? '') ? Number(value) : NaN
/** Per-filament threshold: { thresholdGrams: number | null }; null falls back to the farm default. */
export default defineEventHandler((event) =>
  spoolUsageFeature(
    event,
    getRouterParam(event, 'farmId') ?? '',
    'filament-threshold',
    {
      filamentId: filamentId(getRouterParam(event, 'id')),
    },
  ),
)
