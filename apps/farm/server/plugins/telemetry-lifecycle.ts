import { useRuntimeConfig } from 'nuxt/server'
import { createTelemetryRuntimeLifecycle } from '../services/telemetry-runtime-bootstrap.ts'

/** Disabled unless a future explicit runtime configuration supplies all values. */
export default defineNitroPlugin((nitro) => {
  const lifecycle = createTelemetryRuntimeLifecycle({
    // Fixed text per class, logged on the first failure and on each change.
    onFailure: (reason) =>
      nitro.captureError(new Error(`Telemetry startup failed: ${reason}`), {
        tags: ['telemetry-startup'],
      }),
  })
  nitro.hooks.hook('close', () => lifecycle.close())
  const config: unknown = useRuntimeConfig()
  const telemetry =
    config && typeof config === 'object' && 'connectorTelemetry' in config
      ? config.connectorTelemetry
      : undefined
  // Never blocks startup; retries while the database is still unreachable.
  void lifecycle.startUntilAvailable(telemetry).catch(() => {
    nitro.captureError(new Error('Telemetry startup unavailable'), {
      tags: ['telemetry-startup'],
    })
  })
})
