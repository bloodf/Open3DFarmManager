import { defineEventHandler } from 'nuxt/server'
import { membersRoute } from '../../../../../services/members-http.ts'
import { changeMemberRole } from '../../../../../services/members.ts'

export default defineEventHandler((event) =>
  membersRoute(event, (deps, request, param) =>
    changeMemberRole(deps, request, param('farmId'), param('accountId')),
  ),
)
