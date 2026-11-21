import { handleLegacyRequest } from '../../utils/spool-library/legacy-handler.ts'
import { spoolLibraryRuntime } from '../../utils/spool-library/runtime.ts'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  const url = new URL(event.node.req.url ?? '/', getRequestURL(event).origin)
  const request = new Request(url, { method: event.method })
  const result = await handleLegacyRequest(await spoolLibraryRuntime(), {
    request,
    pathname: url.pathname,
  })
  setResponseStatus(event, result.status)
  return result.body
})
