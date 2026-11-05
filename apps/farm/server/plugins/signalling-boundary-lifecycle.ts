import { useRuntimeConfig } from 'nuxt/server'
import { createSignallingBoundaryLifecycle } from '../services/signalling-boundary-lifecycle.ts'
import { createSignallingRuntimeLifecycle } from '../services/signalling-runtime-bootstrap.ts'
import { parseSignallingRuntimeConfig } from '../services/signalling-runtime-config.ts'
import { authRuntime } from '../utils/auth/runtime.ts'

declare global {
  interface ImportMeta {
    readonly _open3dfarmSignallingBuild?: boolean
    readonly _open3dfarmSignallingPreset?: string
    readonly _websocket?: boolean
  }
}

/** Synchronous plugin execution precedes pinned Nitro's native adapter creation.
 * Missing module replacements are disabled, never a runtime-only enable path. */
export default defineNitroPlugin((nitro) => {
  const lifecycle = createSignallingBoundaryLifecycle()
  const runtime = createSignallingRuntimeLifecycle()
  nitro.hooks.hook('close', async () => {
    lifecycle.close()
    await runtime.close()
  })
  const config: unknown = useRuntimeConfig()
  const signalling =
    config && typeof config === 'object' && 'connectorSignalling' in config
      ? config.connectorSignalling
      : undefined
  const configuration = parseSignallingRuntimeConfig(signalling)
  lifecycle.start({
    config: signalling,
    buildEnabled: import.meta._open3dfarmSignallingBuild === true,
    nativeWebSocketCompiled: import.meta._websocket === true,
    preset: import.meta._open3dfarmSignallingPreset ?? 'unprepared',
    h3App: nitro.h3App,
  })
  if (configuration) {
    const auth = authRuntime()
    if (auth.origin !== configuration.origin)
      throw new Error('Signalling requires its own configured login origin')
    // Pinned Nitro does not await plugin promises. Keep configuration/cap checks
    // synchronous and publish no runtime until asynchronous key/SQL checks finish.
    void runtime.start(configuration, auth.cookie).catch((error: unknown) => {
      nitro.captureError(
        error instanceof Error
          ? error
          : new Error('Signalling startup unavailable'),
        { tags: ['signalling-startup'] },
      )
    })
  }
})
