import { defineEventHandler } from 'nuxt/server'
import { revokeOwnerCredential } from '../../../../../services/integration-owner-apps-http.ts'
import { ownerAppsRuntime } from '../../../../../utils/integration-owner-apps-runtime.ts'

export default defineEventHandler(async (event) => {
  const runtime = await ownerAppsRuntime(event)
  try {
    return await revokeOwnerCredential(
      runtime.deps,
      runtime.actorId,
      runtime.farmId,
      runtime.credentialId,
    )
  } finally {
    await runtime.close()
  }
})
