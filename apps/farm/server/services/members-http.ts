import { createLogger } from '@open3dfarmmanager/shared'
import { createError, getRouterParam, type RequestEvent } from 'nuxt/server'
import { authenticatedSession, limit } from './authenticated-session.ts'
import { MembersError, type MembersDeps } from './members.ts'
import { authRuntime } from '../utils/auth/runtime.ts'

const logger = createLogger('farm-server')

/** Binds the owner member API to the request's session, rate limit and store. */
export async function membersRoute<T>(
  event: RequestEvent,
  run: (
    deps: MembersDeps,
    request: Request,
    param: (name: string) => string,
  ) => Promise<T>,
): Promise<T> {
  const runtime = authRuntime()
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  try {
    return await run(
      {
        origin: runtime.origin,
        store: runtime.members,
        authenticate: () => authenticatedSession(event, runtime),
        limit: (key) => limit(runtime, 'a', key),
      },
      event.req,
      (name) => getRouterParam(event, name) ?? '',
    )
  } catch (error) {
    if (error instanceof MembersError)
      throw createError({ status: error.status, message: error.message })
    if (error instanceof Error && ('status' in error || 'statusCode' in error))
      throw error
    logger.error('members-api-failed', { error })
    throw createError({
      status: 503,
      message: 'Gestão de membros indisponível. Tente novamente.',
    })
  }
}
