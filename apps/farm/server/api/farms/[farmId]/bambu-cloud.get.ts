import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { bambuCloudAccountHttp } from '../../../utils/bambu-cloud/http.ts'

export default defineEventHandler((event) =>
  bambuCloudAccountHttp(event, 'get', {
    farmId: getRouterParam(event, 'farmId') ?? '',
  }),
)
