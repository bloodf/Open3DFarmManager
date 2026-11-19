import { readBrowserDeviceScope } from './browser-device-enrollment.ts'
import { listDeviceKeys, type LocalDeviceKey } from './device-key.ts'
import { readConfigurationBootstrap } from './kobralink-onboarding.ts'
import { openMoonrakerConfigurationBrowserSession } from './moonraker-onboarding-session.ts'
import type { SpoolmanSession } from './spoolman-onboarding.ts'

export type SpoolmanBrowserKey = {
  accountId: string
  keyId: string
  localKey: LocalDeviceKey
}
export type SpoolmanKeyState =
  | { kind: 'available'; key: SpoolmanBrowserKey }
  | {
      kind: 'unavailable'
      reason:
        | 'registry'
        | 'storage'
        | 'missing'
        | 'pending'
        | 'revoked'
        | 'incomplete'
    }

/** First approved browser key of the current account for this farm. */
export async function loadSpoolmanBrowserKey(
  farmId: string,
  signal: AbortSignal,
): Promise<SpoolmanKeyState> {
  let page
  try {
    page = await readBrowserDeviceScope(farmId, signal)
  } catch {
    return { kind: 'unavailable', reason: 'registry' }
  }
  if (page.nextAfter !== null)
    return { kind: 'unavailable', reason: 'incomplete' }
  let localKeys: LocalDeviceKey[]
  try {
    localKeys = await listDeviceKeys({
      farmId,
      accountId: page.currentAccountId,
    })
  } catch {
    return { kind: 'unavailable', reason: 'storage' }
  }
  let pending = false
  let revoked = false
  for (const local of localKeys) {
    const match = page.devices.find(
      (d) =>
        d.accountId === page.currentAccountId &&
        d.thumbprint === local.thumbprint,
    )
    if (!match) continue
    if (match.status === 'approved')
      return {
        kind: 'available',
        key: {
          accountId: page.currentAccountId,
          keyId: match.keyId,
          localKey: local,
        },
      }
    if (match.status === 'pending') pending = true
    if (match.status === 'revoked') revoked = true
  }
  return {
    kind: 'unavailable',
    reason: pending ? 'pending' : revoked ? 'revoked' : 'missing',
  }
}

export function describeSpoolmanKeyState(
  state: Extract<SpoolmanKeyState, { kind: 'unavailable' }>,
) {
  switch (state.reason) {
    case 'pending':
      return 'Este navegador ainda aguarda aprovação em Dispositivos do navegador.'
    case 'revoked':
      return 'O dispositivo deste navegador foi revogado. Cadastre-o novamente.'
    case 'missing':
      return 'Cadastre este navegador em Dispositivos do navegador para configurar o Spoolman.'
    default:
      return 'Não foi possível verificar o dispositivo deste navegador. Tente novamente.'
  }
}

/**
 * Opens one authenticated config-v1 session to a Connector. The session is the
 * only path the Spoolman origin and credentials take; the server issues the
 * authority and never sees them.
 */
export async function openSpoolmanSession(
  farmId: string,
  key: SpoolmanBrowserKey,
  agentId: string,
  signal: AbortSignal,
): Promise<SpoolmanSession> {
  const bootstrap = await readConfigurationBootstrap({
    farmId,
    agentId,
    keyId: key.keyId,
    signal,
  })
  if (!bootstrap.bootstrap.available || bootstrap.bootstrap.revision === null)
    throw new Error('Configuração não disponível neste Connector.')
  const session = await openMoonrakerConfigurationBrowserSession({
    accountId: key.accountId,
    farmId,
    agentId,
    keyId: key.keyId,
    localKey: key.localKey,
    bootstrap,
    signal,
  })
  return {
    advertisedRevision: session.advertisedRevision,
    prepare: (input) => session.prepare(input),
    commit: (input) => session.commit(input),
    cancel: (input) => session.cancel(input),
    close() {
      session.close()
      void session.dispose()
    },
  }
}
