import { defineEventHandler } from 'nuxt/server'
import { membersRoute } from '../../../../services/members-http.ts'
import { listInvites } from '../../../../services/members.ts'

export default defineEventHandler((event) =>
  membersRoute(event, (deps, request, param) =>
    listInvites(deps, request, param('farmId')),
  ),
)
