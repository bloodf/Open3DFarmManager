export type PageFetchOptions = {
  query?: Record<string, string> | undefined
  method?: string | undefined
  body?: unknown
  timeout?: number | undefined
  signal?: AbortSignal | undefined
}

/** Fetch stand-in for mounted pages. An already-aborted signal never leaves the process. */
export async function pageFetch(url: string, options: PageFetchOptions = {}) {
  const query = options.query
    ? '?' + new URLSearchParams(options.query).toString()
    : ''
  const controller = new AbortController()
  const timer =
    options.timeout === undefined
      ? undefined
      : setTimeout(() => controller.abort(), options.timeout)
  const onAbort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', onAbort)
  try {
    if (controller.signal.aborted)
      throw new DOMException('The operation was aborted.', 'AbortError')
    const init: RequestInit = {
      method: options.method ?? 'GET',
      signal: controller.signal,
    }
    if (options.body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(options.body)
    }
    const response = await fetch(url + query, init)
    const data: unknown = await response.json().catch(() => undefined)
    if (!response.ok)
      throw Object.assign(new Error('http'), {
        data,
        statusCode: response.status,
        statusMessage: response.statusText,
      })
    return data
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
