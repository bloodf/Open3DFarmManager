import { defineEventHandler } from 'nuxt/server'
import { uploadIntegrationLibrary } from '../../../../utils/integration-library-http.ts'
import type { IntegrationPrincipal } from '../../../../utils/integration-auth.ts'

export default defineEventHandler((event) =>
  uploadIntegrationLibrary(
    event.req,
    event.context.integrationAuth as IntegrationPrincipal,
    event.res.headers,
  ),
)
