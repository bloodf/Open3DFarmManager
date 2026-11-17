import { defineEventHandler } from 'nuxt/server'
import { membersRoute } from '../../../../services/members-http.ts'
import { listMembers } from '../../../../services/members.ts'

export default defineEventHandler((event) =>
  membersRoute(event, (deps, request, param) =>
    listMembers(deps, request, param('farmId')),
  ),
)
