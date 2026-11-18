import { defineEventHandler, readBody } from 'nuxt/server'
import { createOwnerGrant } from '../../../../../../../services/integration-owner-apps-http.ts'
import { ownerAppsRuntime } from '../../../../../../../utils/integration-owner-apps-runtime.ts'
export default defineEventHandler(async (event) => {
  const runtime = await ownerAppsRuntime(event)
  try {
    return await createOwnerGrant(
      runtime.deps,
      runtime.actorId,
      runtime.farmId,
      runtime.appId,
      await readBody(event),
    )
  } finally {
    await runtime.close()
  }
})
