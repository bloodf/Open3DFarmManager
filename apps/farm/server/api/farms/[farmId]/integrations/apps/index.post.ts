import { defineEventHandler, readBody } from 'nuxt/server'
import { createOwnerApp } from '../../../../../services/integration-owner-apps-http.ts'
import { ownerAppsRuntime } from '../../../../../utils/integration-owner-apps-runtime.ts'
export default defineEventHandler(async (event) => {
  const runtime = await ownerAppsRuntime(event)
  try {
    return await createOwnerApp(
      runtime.deps,
      runtime.actorId,
      runtime.farmId,
      await readBody(event),
    )
  } finally {
    await runtime.close()
  }
})
