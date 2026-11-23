import { createHmac } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import type { LookupAddress, LookupAllOptions } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'

const privateV4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  privateV4.addSubnet(address, prefix)

const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const specialV6 = new BlockList()
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  specialV6.addSubnet(address, prefix, 'ipv6')

function publicAddress(address: string) {
  if (isIP(address) === 4) return !privateV4.check(address)
  return (
    isIP(address) === 6 &&
    globalV6.check(address, 'ipv6') &&
    !specialV6.check(address, 'ipv6')
  )
}

export function parseWebhookUrl(value: string) {
  if (
    !value.startsWith('https://') ||
    value.length > 2048 ||
    /[\s\x00-\x1f\x7f\\#]/u.test(value)
  )
    return null
  try {
    const url = new URL(value)
    return url.hostname && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

type ResolveAddresses = (
  hostname: string,
  options: LookupAllOptions,
) => Promise<LookupAddress[]>

async function lookupWithTimeout(hostname: string, resolve: ResolveAddresses) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const limit = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Webhook DNS timeout')), 3000)
    })
    return await Promise.race([resolve(hostname, { all: true }), limit])
  } finally {
    clearTimeout(timeout)
  }
}

export async function resolveWebhookTarget(
  url: URL,
  sandbox: boolean,
  resolve: ResolveAddresses = lookup,
) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookupWithTimeout(hostname, resolve)
  const [first] = addresses
  if (
    !first ||
    (!sandbox && addresses.some(({ address }) => !publicAddress(address)))
  )
    return null
  return { hostname, address: first.address }
}

export function webhookHeaders(
  eventId: string,
  secret: string,
  body: string,
  now = Date.now(),
) {
  const timestamp = String(Math.floor(now / 1000))
  return {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'OpenFarm-Event-Id': eventId,
    'OpenFarm-Timestamp': timestamp,
    'OpenFarm-Signature':
      'v1=' +
      createHmac('sha256', secret)
        .update(timestamp + '.' + body)
        .digest('hex'),
  }
}

export interface WebhookDelivery {
  subscriptionId: string
  eventId: string
  url: string
  sandbox: boolean
  secret: string
  body: string
  attempts: number
}

export async function sendWebhook(delivery: WebhookDelivery) {
  const url = parseWebhookUrl(delivery.url)
  if (!url) return false
  const target = await resolveWebhookTarget(url, delivery.sandbox)
  if (!target) return false
  // Connect directly to the vetted address. Keep the original host for TLS and HTTP.
  // https.request does not follow redirects.
  return new Promise<boolean>((resolve) => {
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
          ...webhookHeaders(delivery.eventId, delivery.secret, delivery.body),
          host: url.host,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0
        response.destroy()
        resolve(status >= 200 && status < 300)
      },
    )
    outbound.on('error', () => resolve(false))
    outbound.end(delivery.body)
  })
}

export function webhookRetrySeconds(attempts: number) {
  return Math.min(3600, 10 * 2 ** (attempts - 1))
}
