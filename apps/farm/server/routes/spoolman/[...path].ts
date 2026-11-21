import type { H3Event } from 'h3'
import { Readable } from 'node:stream'
import { logUnhandledError } from '../../utils/log-unhandled-error.ts'
import {
  handleLegacyRequest,
  legacyFailure,
} from '../../utils/spool-library/legacy-handler.ts'
import { classifyLegacyBody } from '../../utils/spool-library/legacy-api/body.ts'
import { spoolLibraryRuntime } from '../../utils/spool-library/runtime.ts'
import { createSpoolFeedHooks } from '../../utils/spool-library/ws-feed.ts'
import { splitLegacyPath } from '../../utils/spool-library/legacy-path.ts'
import { readAuthenticatedBody } from './body.ts'

/**
 * The same path serves the Spoolman HTTP API and, for an upgrade request, the
 * upstream websocket feeds (Nitro's websocket support resolves `websocket`).
 */
const websocket = createSpoolFeedHooks({ storage: spoolLibraryRuntime })

export default defineEventHandler({
  websocket,
  handler: handleHttp,
})

async function handleHttp(event: H3Event) {
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
    const bodyMethod = ['POST', 'PATCH', 'PUT'].includes(event.method)
    let raw: string | undefined
    if (bodyMethod) {
      const legacyPath = splitLegacyPath(pathname)
      const auth = legacyPath.ok
        ? await (
            await spoolLibraryRuntime()
          ).withScope(
            { kind: 'legacy-credential', token: legacyPath.token },
            async () => ({ ok: true as const, value: true }),
          )
        : { ok: false as const, reason: 'unauthorized' as const }
      const read = await readAuthenticatedBody(
        Readable.toWeb(event.node.req) as ReadableStream<Uint8Array>,
        async () => auth.ok,
      )
      if (read.status !== 200) {
        setResponseStatus(event, read.status)
        return {
          message:
            read.status === 413
              ? 'Request Entity Too Large'
              : read.status === 408
                ? 'Request Timeout'
                : 'Unauthorized',
        }
      }
      raw = read.body
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
}
