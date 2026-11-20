import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { bambuCloudHistoryHttp } from '../../../../utils/bambu-cloud/import-history-http.ts'

export default defineEventHandler((event) =>
  bambuCloudHistoryHttp(event, {
    farmId: getRouterParam(event, 'farmId') ?? '',
  }),
)
