/**
 * Read an existing Spoolman installation through its documented REST API.
 *
 * GET only, bounded in time, size and page count, redirects refused. The
 * optional bearer token is sent as a header and appears in no URL, error or
 * result. The origin must be vetted by the caller (the farm allowlist); this
 * module only checks that it is a plain http(s) origin without credentials.
 */
export type SourceFailure =
  | 'source-invalid'
  | 'source-unavailable'
  | 'source-unauthorized'
  | 'source-too-large'

export class SourceError extends Error {
  readonly reason: SourceFailure
  constructor(reason: SourceFailure) {
    super(reason)
    this.reason = reason
  }
}

export interface SpoolmanSourceOptions {
  /** Canonical http(s) origin of the Spoolman server, for example http://spoolman.lan:7912 */
  origin: string
  bearerToken?: string | undefined
  fetch?: typeof fetch
  timeoutMs?: number
}
const PAGE = 200
const MAX_PAGES = 500
const MAX_BODY = 16 * 1024 * 1024

/** The only origin shape accepted: scheme, host and optional port, nothing else. */
export function canonicalOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 255) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    return null
  return url.origin
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY) throw new SourceError('source-too-large')
  const reader = response.body?.getReader()
  if (!reader) throw new SourceError('source-invalid')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {})
      throw new SourceError('source-too-large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function readSpoolmanLibrary(
  options: SpoolmanSourceOptions,
): Promise<Record<string, unknown>> {
  const origin = canonicalOrigin(options.origin)
  if (!origin) throw new SourceError('source-invalid')
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const deadline = Date.now() + 120_000

  async function get(
    path: string,
  ): Promise<{ body: unknown; total: number | null }> {
    if (Date.now() > deadline) throw new SourceError('source-unavailable')
    let response: Response
    try {
      response = await doFetch(`${origin}${path}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...(options.bearerToken
            ? { Authorization: `Bearer ${options.bearerToken}` }
            : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      // Driver and DNS text can echo the URL; the caller learns only the class.
      throw new SourceError('source-unavailable')
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      throw new SourceError('source-unauthorized')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new SourceError('source-unavailable')
    }
    if (!(response.headers.get('content-type') ?? '').includes('json')) {
      await response.body?.cancel().catch(() => {})
      throw new SourceError('source-invalid')
    }
    const totalHeader = response.headers.get('x-total-count')
    let body: unknown
    try {
      body = JSON.parse(await boundedText(response))
    } catch (error) {
      if (error instanceof SourceError) throw error
      throw new SourceError('source-invalid')
    }
    return {
      body,
      total:
        totalHeader !== null && /^\d{1,9}$/.test(totalHeader)
          ? Number(totalHeader)
          : null,
    }
  }

  async function all(path: string, extra = ''): Promise<unknown[]> {
    const out: unknown[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const { body, total } = await get(
        `${path}?limit=${PAGE}&offset=${out.length}${extra}`,
      )
      if (!Array.isArray(body)) throw new SourceError('source-invalid')
      out.push(...body)
      if (body.length < PAGE || (total !== null && out.length >= total))
        return out
    }
    throw new SourceError('source-too-large')
  }

  const info = await get('/api/v1/info')
  if (
    typeof info.body !== 'object' ||
    info.body === null ||
    Array.isArray(info.body)
  )
    throw new SourceError('source-invalid')
  const fields: Record<string, unknown[]> = {}
  for (const kind of ['vendor', 'filament', 'spool']) {
    const { body } = await get(`/api/v1/field/${kind}`)
    if (!Array.isArray(body)) throw new SourceError('source-invalid')
    fields[kind] = body
  }
  const settings = await get('/api/v1/setting/')
  if (
    typeof settings.body !== 'object' ||
    settings.body === null ||
    Array.isArray(settings.body)
  )
    throw new SourceError('source-invalid')
  return {
    vendors: await all('/api/v1/vendor'),
    filaments: await all('/api/v1/filament'),
    spools: await all('/api/v1/spool', '&allow_archived=true'),
    fields,
    settings: settings.body,
  }
}
