import { useRuntimeConfig } from 'nuxt/server'
import { createTelemetryRuntimeLifecycle } from '../services/telemetry-runtime-bootstrap.ts'

/** Disabled unless a future explicit runtime configuration supplies all values. */
export default defineNitroPlugin(async (nitro) => {
  const lifecycle = createTelemetryRuntimeLifecycle()
  nitro.hooks.hook('close', () => lifecycle.close())
  const config: unknown = useRuntimeConfig()
  const telemetry =
    config && typeof config === 'object' && 'connectorTelemetry' in config
      ? config.connectorTelemetry
      : undefined
  await lifecycle.start(telemetry)
})
