import postgres from 'postgres'
import { createError, useRuntimeConfig } from 'nuxt/server'
import {
  BrowserDeviceHttpRuntimeConfig,
  BROWSER_DEVICE_HTTP_AUDIENCE,
} from '../../../../../packages/farm-protocol/src/browser-device-http.ts'
import { PairingProofOrigin } from '../../../../../packages/farm-protocol/src/pairing-proof.ts'
import { PostgresBrowserDeviceRegistry } from '../../storage/postgres-browser-device-registry.ts'
import { authRuntime } from '../auth/runtime.ts'
import type { BrowserDeviceHttpRuntime } from '../../services/browser-devices.ts'

let instance: BrowserDeviceHttpRuntime | undefined
let closePool: (() => Promise<void>) | undefined
export function browserDevicesRuntime(): BrowserDeviceHttpRuntime {
  const config: unknown = Reflect.get(useRuntimeConfig(), 'browserDevices')
  if (
    typeof config !== 'object' ||
    config === null ||
    !('enabled' in config) ||
    config.enabled !== true
  )
    throw createError({ status: 404, message: 'Recurso indisponível.' })
  if (instance) return instance
  try {
    const parsed = BrowserDeviceHttpRuntimeConfig.parse(config)
    const auth = authRuntime()
    PairingProofOrigin.parse(auth.origin)
    const sql = postgres(parsed.databaseUrl, {
      max: 4,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: {
        statement_timeout: 2000,
        lock_timeout: 1000,
        transaction_timeout: 10000,
        options: '-c role=farm_browser_device_runtime',
      },
    })
    closePool = () => sql.end({ timeout: 3 })
    instance = {
      auth,
      registry: new PostgresBrowserDeviceRegistry(sql, {
        origin: auth.origin,
        audience: BROWSER_DEVICE_HTTP_AUDIENCE,
      }),
      admission: { active: 0 },
    }
    return instance
  } catch {
    throw createError({
      status: 503,
      message: 'Serviço de dispositivos indisponível. Tente novamente.',
    })
  }
}
export async function closeBrowserDevicesRuntime(): Promise<void> {
  try {
    await closePool?.()
  } finally {
    closePool = undefined
    instance = undefined
  }
}
