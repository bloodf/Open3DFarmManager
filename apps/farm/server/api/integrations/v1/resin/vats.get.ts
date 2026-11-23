import { defineEventHandler } from 'nuxt/server'
import { resinResponse } from '../../../../utils/integration-resin-http.ts'
import { listIntegrationResinVats } from '../../../../utils/integration-resin.ts'

export default defineEventHandler((event) =>
  resinResponse(event, listIntegrationResinVats),
)
