import { randomUUID } from 'node:crypto'
import { request } from 'node:https'
import { isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import {
  parseWebhookUrl,
  resolveWebhookTarget,
  webhookHeaders,
} from '../../services/webhook-delivery.ts'
import { openWebhookSecret } from '../webhooks/secret.ts'

export function parseNotificationChannel(body: unknown) {
  if (
    !body ||
    typeof body !== 'object' ||
    Object.keys(body).length !== 2 ||
    !('url' in body) ||
    typeof body.url !== 'string' ||
    !('secret' in body) ||
    typeof body.secret !== 'string' ||
    body.secret.length < 32 ||
    body.secret.length > 256
  )
    return null
  const url = parseWebhookUrl(body.url)
  return url ? { url: url.href, secret: body.secret } : null
}

export function openNotificationChannel(sealed: string, keyring: string) {
  const opened = openWebhookSecret(sealed, keyring)
  return opened.legacy
    ? null
    : parseNotificationChannel(JSON.parse(opened.secret))
}

export type NotificationTestResult =
  | { attempted: true; status: 'delivered' | 'failed' }
  | { attempted: false; status: 'not-run' }

const notRun = { attempted: false, status: 'not-run' } as const

export async function deliverNotificationTest(
  farmId: string,
  channel: NonNullable<ReturnType<typeof parseNotificationChannel>>,
): Promise<NotificationTestResult> {
  const url = parseWebhookUrl(channel.url)
  if (!url) return notRun
  const target = await resolveWebhookTarget(url, false).catch(() => null)
  if (!target) return notRun

  const id = randomUUID()
  const occurredAt = Date.now()
  const body = JSON.stringify({
    id,
    type: 'farm.notification.test',
    occurredAt,
    data: { farmId, message: 'Teste do canal de notificação do OpenFarm.' },
  })
  return new Promise<NotificationTestResult>((resolve) => {
    try {
      const outbound = request(
        {
          hostname: target.address,
          port: url.port || 443,
          servername: isIP(target.hostname) ? '' : target.hostname,
          checkServerIdentity: (_, cert) =>
            checkServerIdentity(target.hostname, cert),
          method: 'POST',
          path: url.pathname + url.search,
          agent: false,
          rejectUnauthorized: true,
          signal: AbortSignal.timeout(5000),
          headers: {
            ...webhookHeaders(id, channel.secret, body, occurredAt),
            host: url.host,
          },
        },
        (response) => {
          const status = response.statusCode ?? 0
          response.destroy()
          resolve({
            attempted: true,
            status: status >= 200 && status < 300 ? 'delivered' : 'failed',
          })
        },
      )
      outbound.on('error', () => resolve({ attempted: true, status: 'failed' }))
      outbound.end(body)
    } catch {
      resolve(notRun)
    }
  })
}
