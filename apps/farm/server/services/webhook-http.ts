import {
  integrationBase,
  integrationProblem,
  PayloadTooLarge,
  readText,
} from '../utils/integration-auth-http.ts'
import {
  uuidPattern,
  type IntegrationPrincipal,
} from '../utils/integration-auth.ts'
import {
  webhookEvents,
  type PostgresWebhooks,
  type WebhookInput,
} from '../storage/webhook-postgres.ts'
import { parseWebhookUrl, resolveWebhookTarget } from './webhook-delivery.ts'

type WebhookStore = Pick<
  PostgresWebhooks,
  'list' | 'sandbox' | 'create' | 'delete' | 'queueTest'
>

function parseInput(body: unknown): WebhookInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (
    Object.keys(body).some(
      (key) => !['url', 'events', 'description'].includes(key),
    )
  )
    return null
  if (!('url' in body) || typeof body.url !== 'string') return null
  if (!('events' in body) || !Array.isArray(body.events)) return null
  const requested = body.events
  const events = webhookEvents.filter((event) => requested.includes(event))
  if (events.length === 0 || events.length !== body.events.length) return null
  if (!('description' in body)) return { url: body.url, events }
  if (
    typeof body.description !== 'string' ||
    [...body.description].length > 255 ||
    body.description.includes('\0')
  )
    return null
  return { url: body.url, events, description: body.description }
}

export async function webhookRequest(
  request: Request,
  principal: IntegrationPrincipal,
  store: WebhookStore,
  headers: HeadersInit,
  id?: string,
) {
  if (
    !principal.grants.some((grant) => grant.scopes.includes('events:subscribe'))
  )
    return integrationProblem('insufficient-scope', headers)

  if (id !== undefined && !uuidPattern.test(id))
    return integrationProblem('invalid-request', headers)

  const appId = principal.appId
  if (id !== undefined) {
    if (request.method === 'DELETE') {
      return (await store.delete(appId, id))
        ? new Response(null, { status: 204, headers })
        : integrationProblem('not-found', headers)
    }
    if (
      request.body &&
      (await readText(request, 1).catch(() => 'invalid')) !== ''
    )
      return integrationProblem('invalid-request', headers)
    const queued = await store.queueTest(appId, id)
    return queued
      ? Response.json(queued, { status: 202, headers })
      : integrationProblem('not-found', headers)
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const query = new URL(request.url).searchParams
    const limits = query.getAll('limit')
    const cursors = query.getAll('cursor')
    const rawLimit = limits[0] ?? '50'
    const limit = Number(rawLimit)
    const cursor = cursors[0]
    const after =
      cursor && cursor.length <= 512
        ? Buffer.from(cursor, 'base64url').toString()
        : null
    if (
      limits.length > 1 ||
      cursors.length > 1 ||
      !/^\d+$/.test(rawLimit) ||
      limit < 1 ||
      limit > 100 ||
      (cursor !== undefined &&
        (!after ||
          !uuidPattern.test(after) ||
          Buffer.from(after).toString('base64url') !== cursor))
    )
      return integrationProblem('invalid-request', headers)
    return Response.json(await store.list(appId, after, limit), { headers })
  }

  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    return integrationProblem('unsupported-media-type', headers)

  let body: unknown
  try {
    body = JSON.parse(await readText(request, 16 * 1024))
  } catch (error) {
    return integrationProblem(
      error instanceof PayloadTooLarge
        ? 'payload-too-large'
        : 'invalid-request',
      headers,
    )
  }
  const input = parseInput(body)
  if (!input) return integrationProblem('validation-failed', headers)
  const url = parseWebhookUrl(input.url)
  if (!url) return integrationProblem('validation-failed', headers)
  const sandbox = await store.sandbox(appId)
  if (sandbox === undefined) return integrationProblem('invalid-token', headers)
  if (!(await resolveWebhookTarget(url, sandbox).catch(() => null)))
    return integrationProblem('unsafe-target', headers)

  const created = await store.create(appId, input)
  if (typeof created === 'string') return integrationProblem(created, headers)
  const responseHeaders = new Headers(headers)
  responseHeaders.set('cache-control', 'no-store')
  responseHeaders.set('location', integrationBase + '/webhooks/' + created.id)
  return Response.json(created, { status: 201, headers: responseHeaders })
}
