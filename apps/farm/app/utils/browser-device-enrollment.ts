import {
  BROWSER_DEVICE_HTTP_AUDIENCE,
  BrowserDeviceHttpAccountResponse,
  BrowserDeviceHttpListResponse,
  BrowserDeviceHttpChallengeResponse,
  BrowserDeviceHttpMutationResponse,
} from '../../../../packages/farm-protocol/src/browser-device-http.ts'
import { signBrowserDeviceProof } from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import type { DeviceKeyScope, LocalDeviceKey } from './device-key'

const options = (signal: AbortSignal) => ({
  signal,
  retry: 0,
  timeout: 15_000,
  cache: 'no-store' as const,
})

/** Fresh server-authorized scope. No cookie or internal login reference enters browser state. */
export async function readBrowserDeviceScope(
  farmId: string,
  signal: AbortSignal,
  after?: string,
) {
  const me = BrowserDeviceHttpAccountResponse.parse(
    await $fetch('/api/auth/me', options(signal)),
  )
  const page = BrowserDeviceHttpListResponse.parse(
    await $fetch('/api/browser-devices', {
      ...options(signal),
      query: { farm_id: farmId, limit: 20, ...(after ? { after } : {}) },
    }),
  )
  if (signal.aborted || me.accountId !== page.currentAccountId)
    throw new Error('A conta mudou. Atualize a página.')
  return page
}

export async function proveBrowserDevice(input: {
  scope: DeviceKeyScope
  key: LocalDeviceKey
  purpose: 'enroll' | 'recover'
  signal: AbortSignal
  isCurrent: () => boolean
}) {
  const current = async () => {
    if (!input.isCurrent() || input.signal.aborted)
      throw new Error('Operação cancelada.')
    const page = await readBrowserDeviceScope(input.scope.farmId, input.signal)
    if (!input.isCurrent() || page.currentAccountId !== input.scope.accountId)
      throw new Error('A conta mudou. Atualize a página.')
  }
  await current()
  const response = BrowserDeviceHttpChallengeResponse.parse(
    await $fetch(
      input.purpose === 'enroll'
        ? '/api/browser-devices/challenges'
        : '/api/browser-devices/recovery-challenges',
      {
        ...options(input.signal),
        method: 'POST',
        body: { farm_id: input.scope.farmId, public_key: input.key.publicKey },
      },
    ),
  )
  const challenge = response.challenge
  await current()
  if (
    challenge.account_id !== input.scope.accountId ||
    challenge.farm_id !== input.scope.farmId ||
    challenge.thumbprint !== input.key.thumbprint ||
    challenge.purpose !== input.purpose ||
    challenge.origin !== window.location.origin ||
    challenge.audience !== BROWSER_DEVICE_HTTP_AUDIENCE ||
    challenge.issued_at > Date.now() ||
    challenge.expires_at <= Date.now()
  )
    throw new Error('Desafio de posse inválido ou expirado.')
  const signature = await signBrowserDeviceProof(
    challenge,
    input.key.keyPair.privateKey,
  )
  await current()
  if (challenge.expires_at <= Date.now())
    throw new Error(
      'O prazo de 60 segundos expirou. Atualize para consultar o resultado.',
    )
  return BrowserDeviceHttpMutationResponse.parse(
    await $fetch('/api/browser-devices/proofs', {
      ...options(input.signal),
      method: 'POST',
      body: { challenge_id: challenge.challenge_id, signature },
    }),
  )
}

export async function decideBrowserDevice(input: {
  farmId: string
  accountId: string
  device: BrowserDeviceHttpListResponse['devices'][number]
  operation: 'approve' | 'revoke'
  signal: AbortSignal
  isCurrent: () => boolean
}) {
  const page = await readBrowserDeviceScope(input.farmId, input.signal)
  if (
    !input.isCurrent() ||
    page.currentAccountId !== input.accountId ||
    !['owner', 'admin'].includes(page.currentRole)
  )
    throw new Error('Autorização atual indisponível.')
  return BrowserDeviceHttpMutationResponse.parse(
    await $fetch(`/api/browser-devices/${input.operation}`, {
      ...options(input.signal),
      method: 'POST',
      body: {
        farm_id: input.farmId,
        key_id: input.device.keyId,
        expected_thumbprint: input.device.thumbprint,
      },
    }),
  )
}
