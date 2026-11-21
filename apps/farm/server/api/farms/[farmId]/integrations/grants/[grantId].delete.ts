import { defineEventHandler } from 'nuxt/server'
import {
  requireOwnerAppsMutation,
  revokeOwnerGrant,
} from '../../../../../services/integration-owner-apps-http.ts'
import { ownerAppsRuntime } from '../../../../../utils/integration-owner-apps-runtime.ts'
import { authRuntime } from '../../../../../utils/auth/runtime.ts'

export default defineEventHandler(async (event) => {
  requireOwnerAppsMutation(event, authRuntime())
  const runtime = await ownerAppsRuntime(event)
  try {
    return await revokeOwnerGrant(
      runtime.deps,
      runtime.actorId,
      runtime.farmId,
      runtime.grantId,
    )
  } finally {
    await runtime.close()
  }
})
