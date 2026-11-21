import { logUnhandledError } from '../../utils/log-unhandled-error.ts'
import {
  handleLegacyRequest,
  legacyFailure,
} from '../../utils/spool-library/legacy-handler.ts'
import { classifyLegacyBody } from '../../utils/spool-library/legacy-api/body.ts'
import { spoolLibraryRuntime } from '../../utils/spool-library/runtime.ts'

/** Upstream allows 128 extra fields of 65535 characters; leave room for that. */
const MAX_BODY_BYTES = 10 * 1024 * 1024

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  let result
  try {
    const url = event.node.req.url ?? '/'
    const queryAt = url.indexOf('?')
    const pathname = queryAt === -1 ? url : url.slice(0, queryAt)
    const query = new URLSearchParams(
      queryAt === -1 ? '' : url.slice(queryAt + 1),
    )
    const length = Number(getRequestHeader(event, 'content-length') ?? 0)
    if (length > MAX_BODY_BYTES) {
      setResponseStatus(event, 413)
      return { message: 'Request Entity Too Large' }
    }
    const raw = ['POST', 'PATCH', 'PUT'].includes(event.method)
      ? await readRawBody(event, 'utf8')
      : undefined
    if (raw && Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      setResponseStatus(event, 413)
      return { message: 'Request Entity Too Large' }
    }
    result = await handleLegacyRequest(await spoolLibraryRuntime(), {
      method: event.method,
      pathname,
      query,
      body: classifyLegacyBody(raw, getRequestHeader(event, 'content-type')),
    })
  } catch (error) {
    logUnhandledError(error, { path: '/spoolman/' })
    const status = (error as { statusCode?: unknown } | null)?.statusCode
    result = legacyFailure(status === 404 ? 'not-found' : 'storage-unavailable')
  }
  setResponseStatus(event, result.status)
  for (const [name, value] of Object.entries(result.headers ?? {}))
    setResponseHeader(event, name, value)
  return result.body
})
