// Drives the real v1 route files in-process, the way Nitro would: the
// authorizing middleware first, then the file route that matches the path and
// method, with h3's handling of a returned plain object (JSON 200 carrying the
// headers the middleware set on the event).
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, relative, sep } from 'node:path'

export const apiBase = '/api/integrations/v1'
const routesDir = fileURLToPath(
  new URL('../../../apps/farm/server/api/integrations/v1', import.meta.url),
)
const middlewareFile = fileURLToPath(
  new URL(
    '../../../apps/farm/server/middleware/integrations-auth.ts',
    import.meta.url,
  ),
)

export interface RouteFile {
  file: string
  method: string | null
  segments: string[]
  catchAll: boolean
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  )
}

/** Every file route under api/integrations/v1, as Nitro's file router sees it. */
export function routeFiles(): RouteFile[] {
  return walk(routesDir).map((file) => {
    const parts = relative(routesDir, file).slice(0, -3).split(sep)
    const last = parts.pop() as string
    const match = /^(.*)\.(get|post|put|patch|delete|head|options)$/.exec(last)
    const name = match ? (match[1] as string) : last
    const segments = name === 'index' ? parts : [...parts, name]
    return {
      file,
      method: match ? (match[2] as string).toUpperCase() : null,
      segments,
      catchAll: segments.some((segment) => segment.startsWith('[...')),
    }
  })
}

const isParam = (segment: string) => /^\[[^.\]]+\]$/.test(segment)
const paramName = (segment: string) => segment.slice(1, -1)

export function matchRoute(method: string, path: string) {
  const parts = path.split('/').filter(Boolean)
  const candidates = routeFiles().filter(
    (route) => route.method === null || route.method === method,
  )
  let best:
    | { route: RouteFile; params: Record<string, string>; score: number }
    | undefined
  for (const route of candidates) {
    const params: Record<string, string> = {}
    let score = 0
    let ok = true
    if (route.catchAll) {
      const prefix = route.segments.slice(0, -1)
      ok = prefix.every((segment, index) => segment === parts[index])
      score = prefix.length
    } else {
      ok =
        route.segments.length === parts.length &&
        route.segments.every((segment, index) => {
          if (isParam(segment)) {
            params[paramName(segment)] = decodeURIComponent(
              parts[index] as string,
            )
            score += 1
            return true
          }
          score += 3
          return segment === parts[index]
        })
      score += 1000
    }
    if (ok && (!best || score > best.score)) best = { route, params, score }
  }
  return best
}

export interface CallInput {
  method: string
  /** Path below the v1 base, with optional query string. */
  path: string
  headers?: Record<string, string>
  body?: string | Record<string, unknown> | unknown[]
  token?: string
}
export interface CallResult {
  status: number
  headers: Headers
  text: string
  json: unknown
  /** True when no v1 handler claimed the request (Nitro would answer). */
  unrouted: boolean
}

async function finish(
  result: unknown,
  eventHeaders: Headers,
): Promise<Response> {
  if (result instanceof Response) {
    const headers = new Headers(result.headers)
    for (const [name, value] of eventHeaders)
      if (!headers.has(name)) headers.set(name, value)
    return new Response(result.body, { status: result.status, headers })
  }
  const headers = new Headers(eventHeaders)
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(result ?? null), { status: 200, headers })
}

export async function call(input: CallInput): Promise<CallResult> {
  const headers = new Headers(input.headers)
  if (input.token) headers.set('authorization', `Bearer ${input.token}`)
  let body: string | undefined
  if (typeof input.body === 'string') body = input.body
  else if (input.body !== undefined) {
    body = JSON.stringify(input.body)
    if (!headers.has('content-type'))
      headers.set('content-type', 'application/json')
  }
  const url = `https://farm.example.invalid${apiBase}${input.path}`
  const request = new Request(url, {
    method: input.method,
    headers,
    ...(body !== undefined && input.method !== 'GET' ? { body } : {}),
  })
  const event = {
    req: request,
    res: { headers: new Headers() },
    context: {} as Record<string, unknown>,
  }
  const middleware = (
    await import(/* @vite-ignore */ pathToFileURL(middlewareFile).href)
  ).default as (event: unknown) => Promise<unknown>
  const early = await middleware(event)
  let response: Response
  let unrouted = false
  if (early instanceof Response) response = early
  else {
    const route = matchRoute(
      input.method,
      new URL(url).pathname.slice(apiBase.length),
    )
    if (!route) {
      unrouted = true
      response = new Response(null, { status: 404 })
    } else {
      const handler = (
        await import(/* @vite-ignore */ pathToFileURL(route.route.file).href)
      ).default as (event: unknown) => Promise<unknown>
      event.context.params = route.params
      response = await finish(await handler(event), event.res.headers)
    }
  }
  const text = await response.text()
  let json: unknown = undefined
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
    unrouted,
  }
}
