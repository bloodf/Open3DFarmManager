import { defineEventHandler } from 'nuxt/server'
import { membersRoute } from '../../../../../services/members-http.ts'
import { removeMember } from '../../../../../services/members.ts'

export default defineEventHandler((event) =>
  membersRoute(event, (deps, request, param) =>
    removeMember(deps, request, param('farmId'), param('accountId')),
  ),
)
