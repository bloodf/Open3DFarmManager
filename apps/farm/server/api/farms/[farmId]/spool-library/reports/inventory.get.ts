import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolInventoryReport } from '../../../../../services/spool-usage.ts'
export default defineEventHandler((event) =>
  spoolInventoryReport(event, getRouterParam(event, 'farmId') ?? ''),
)
