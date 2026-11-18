import { defineEventHandler } from 'nuxt/server'
import { listOwnerApps } from '../../../../../services/integration-owner-apps-http.ts'
import { ownerAppsRuntime } from '../../../../../utils/integration-owner-apps-runtime.ts'
export default defineEventHandler(async (event) => {
  const runtime = await ownerAppsRuntime(event)
  try {
    return await listOwnerApps(runtime.deps, runtime.actorId, runtime.farmId)
  } finally {
    await runtime.close()
  }
})
