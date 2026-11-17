import { discovery, None, type Configuration } from 'openid-client'
import type { OidcSettings } from './oidc-config.ts'

let pending: Promise<Configuration> | undefined
let pendingKey = ''

/** Discovers the one configured issuer. HTTPS only; tests call `discovery` themselves. */
export function oidcConfiguration(
  settings: OidcSettings,
): Promise<Configuration> {
  const secret = settings.clientSecret
  const key =
    settings.issuer + '\n' + settings.clientId + '\n' + (secret ? '1' : '0')
  if (pending && pendingKey === key) return pending
  pendingKey = key
  const next = discovery(
    new URL(settings.issuer),
    settings.clientId,
    secret,
    secret ? undefined : None(),
  ).catch((error: unknown) => {
    if (pending === next) pending = undefined
    throw error
  })
  pending = next
  return next
}

export function resetOidcConfiguration(): void {
  pending = undefined
  pendingKey = ''
}
