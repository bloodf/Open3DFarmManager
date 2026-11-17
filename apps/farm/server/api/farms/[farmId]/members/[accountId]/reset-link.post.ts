import { defineEventHandler } from 'nuxt/server'
import { membersRoute } from '../../../../../services/members-http.ts'
import { issueResetLink } from '../../../../../services/password-reset-links.ts'
import { passwordResetRuntime } from '../../../../../utils/auth/password-reset-runtime.ts'

/** Owner-only. The link is shown once; it is never stored or logged. */
export default defineEventHandler((event) => {
  const reset = passwordResetRuntime(event.context.passwordReset)
  event.res.headers.set('Cache-Control', 'no-store')
  return membersRoute(event, (deps, request, param) =>
    issueResetLink(
      { ...deps, store: reset.store },
      request,
      param('farmId'),
      param('accountId'),
    ),
  )
})
