import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolSlotsFeature } from '../../../../../services/spool-slots-http.ts'
export default defineEventHandler((event) =>
  spoolSlotsFeature(event, getRouterParam(event, 'farmId'), 'list'),
)
