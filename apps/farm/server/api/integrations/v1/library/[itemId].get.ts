import { defineEventHandler } from 'nuxt/server'
import { readIntegrationLibraryItem } from '../../../../utils/integration-library-http.ts'
import type { IntegrationPrincipal } from '../../../../utils/integration-auth.ts'

export default defineEventHandler((event) =>
  readIntegrationLibraryItem(
    event.context.integrationAuth as IntegrationPrincipal,
    event.context.params?.itemId ?? '',
    event.res.headers,
  ),
)
