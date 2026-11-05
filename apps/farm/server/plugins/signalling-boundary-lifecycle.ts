import { useRuntimeConfig } from 'nuxt/server'
import { createSignallingBoundaryLifecycle } from '../services/signalling-boundary-lifecycle.ts'

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
  nitro.hooks.hook('close', () => lifecycle.close())
  const config: unknown = useRuntimeConfig()
  const signalling =
    config && typeof config === 'object' && 'connectorSignalling' in config
      ? config.connectorSignalling
      : undefined
  lifecycle.start({
    config: signalling,
    buildEnabled: import.meta._open3dfarmSignallingBuild === true,
    nativeWebSocketCompiled: import.meta._websocket === true,
    preset: import.meta._open3dfarmSignallingPreset ?? 'unprepared',
    h3App: nitro.h3App,
  })
})
