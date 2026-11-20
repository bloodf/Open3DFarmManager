import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { bambuCloudPrintersHttp } from '../../../../utils/bambu-cloud/import-printers-http.ts'

export default defineEventHandler((event) =>
  bambuCloudPrintersHttp(event, {
    farmId: getRouterParam(event, 'farmId') ?? '',
  }),
)
