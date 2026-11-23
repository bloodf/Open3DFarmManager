import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolUsageReport } from '../../../../../services/spool-usage.ts'
export default defineEventHandler((event) =>
  spoolUsageReport(event, getRouterParam(event, 'farmId') ?? ''),
)
