import { createError } from 'nuxt/server'
import type { ConfigurationHttpRuntime } from '../../services/configuration-http.ts'
import type { ConfigurationSignallingRuntime } from '../../services/configuration-signalling-runtime.ts'

export interface ConfigurationRuntime {
  readonly issuer?: {
    protocol: string
    issuerKid: string
    origin: string
    audience: string
    publicKeyJwk: object
  }
  readonly http: ConfigurationHttpRuntime
  readonly signalling: ConfigurationSignallingRuntime
}
let installed: ConfigurationRuntime | undefined

/**
 * Installed only by a lifecycle that owns a transactional authority store and
 * the dedicated issuer key. There is no default: until then every config-v1
 * route answers 404/403 and nothing is granted.
 */
export function installConfigurationRuntime(
  runtime: ConfigurationRuntime,
): () => void {
  if (installed) throw new Error('Configuration runtime already installed')
  installed = runtime
  return () => {
    if (installed !== runtime) return
    installed = undefined
    runtime.http.authority.close()
    runtime.signalling.close()
  }
}
export function configurationSignallingRuntime():
  ConfigurationSignallingRuntime | undefined {
  return installed?.signalling
}
export function configurationHttpRuntime(): ConfigurationHttpRuntime {
  if (!installed)
    throw createError({
      status: 404,
      message: 'Configuração de impressoras indisponível.',
    })
  return installed.http
}

export function configurationIssuerMetadata() {
  const value = installed?.issuer
  if (!value)
    throw createError({ status: 404, message: 'Emissor indisponível.' })
  return value
}
