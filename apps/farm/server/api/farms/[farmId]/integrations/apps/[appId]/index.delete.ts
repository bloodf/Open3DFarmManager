import { defineEventHandler } from 'nuxt/server'
import { revokeOwnerApp } from '../../../../../../services/integration-owner-apps-http.ts'
import { ownerAppsRuntime } from '../../../../../../utils/integration-owner-apps-runtime.ts'

export default defineEventHandler(async (event) => {
  const runtime = await ownerAppsRuntime(event)
  try {
    return await revokeOwnerApp(
      runtime.deps,
      runtime.actorId,
      runtime.farmId,
      runtime.appId,
    )
  } finally {
    await runtime.close()
  }
})
