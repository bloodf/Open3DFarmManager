import { logUnhandledError } from '../../utils/log-unhandled-error.ts'
import {
  handleLegacyRequest,
  legacyFailure,
} from '../../utils/spool-library/legacy-handler.ts'
import { spoolLibraryRuntime } from '../../utils/spool-library/runtime.ts'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  let result
  try {
    const pathname = event.node.req.url?.split('?', 1)[0] ?? '/'
    result = await handleLegacyRequest(await spoolLibraryRuntime(), {
      method: event.method,
      pathname,
    })
  } catch (error) {
    logUnhandledError(error, { path: '/spoolman/' })
    const status = (error as { statusCode?: unknown } | null)?.statusCode
    result = legacyFailure(status === 404 ? 'not-found' : 'storage-unavailable')
  }
  setResponseStatus(event, result.status)
  return result.body
})
