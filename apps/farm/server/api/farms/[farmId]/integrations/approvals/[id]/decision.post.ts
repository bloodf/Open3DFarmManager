import { defineEventHandler } from 'nuxt/server'
import { decideApprovalRequest } from '../../../../../../services/integration-approval-http.ts'
import { approvalHttpDeps } from '../../../../../../utils/integration-approval-http-runtime.ts'

export default defineEventHandler(async (event) => {
  const { deps, param } = await approvalHttpDeps(event)
  return decideApprovalRequest(event.req, deps, param('farmId'), param('id'))
})
