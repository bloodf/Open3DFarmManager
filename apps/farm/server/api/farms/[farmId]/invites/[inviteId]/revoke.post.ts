import { defineEventHandler } from 'nuxt/server'
import { membersRoute } from '../../../../../services/members-http.ts'
import { revokeInvite } from '../../../../../services/members.ts'

export default defineEventHandler((event) =>
  membersRoute(event, (deps, request, param) =>
    revokeInvite(deps, request, param('farmId'), param('inviteId')),
  ),
)
