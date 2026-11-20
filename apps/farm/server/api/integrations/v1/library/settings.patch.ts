import { defineEventHandler } from 'nuxt/server'
import { patchIntegrationLibrarySettings } from '../../../../utils/integration-library-http.ts'
import type { IntegrationPrincipal } from '../../../../utils/integration-auth.ts'

export default defineEventHandler((event) =>
  patchIntegrationLibrarySettings(
    event.req,
    event.context.integrationAuth as IntegrationPrincipal,
    event.res.headers,
  ),
)
