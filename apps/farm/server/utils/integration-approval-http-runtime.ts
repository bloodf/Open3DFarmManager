import { createError, getRouterParam, type RequestEvent } from 'nuxt/server'
import {
  authenticatedSession,
  authResponse,
  limit,
} from '../services/authenticated-session.ts'
import type { ApprovalHttpDeps } from '../services/integration-approval-http.ts'
import { authRuntime } from './auth/runtime.ts'
import { integrationJobsRuntime } from './integration-jobs-runtime.ts'

/** Binds the approval handlers to the request's session, rate limit and runtime. */
export async function approvalHttpDeps(
  event: RequestEvent,
): Promise<{ deps: ApprovalHttpDeps; param: (name: string) => string }> {
  const auth = authRuntime()
  authResponse(event)
  let service
  try {
    service = (await integrationJobsRuntime()).approvals
  } catch {
    throw createError({
      status: 503,
      message: 'Aprovações indisponíveis. Tente novamente.',
    })
  }
  return {
    deps: {
      origin: auth.origin,
      authenticate: () => authenticatedSession(event, auth),
      limit: (key) => limit(auth, 'a', key),
      service,
    },
    param: (name) => getRouterParam(event, name) ?? '',
  }
}
