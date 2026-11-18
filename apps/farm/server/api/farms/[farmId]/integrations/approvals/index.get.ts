import { defineEventHandler } from 'nuxt/server'
import { listApprovalsRequest } from '../../../../../services/integration-approval-http.ts'
import { approvalHttpDeps } from '../../../../../utils/integration-approval-http-runtime.ts'

export default defineEventHandler(async (event) => {
  const { deps, param } = await approvalHttpDeps(event)
  return listApprovalsRequest(deps, param('farmId'))
})
