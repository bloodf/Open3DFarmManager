import { defineNuxtModule } from 'nuxt/kit'
import { signallingBuildEnabled } from '../server/services/signalling-build-policy.ts'

/** Local Nuxt modules are discovered at build time. Merely discovering this file
 * never enables Nitro WebSockets; private configuration must explicitly opt in. */
export default defineNuxtModule({
  meta: { name: 'open3dfarm-signalling' },
  setup(_options, nuxt) {
    const config: unknown = nuxt.options.runtimeConfig
    const signalling =
      config && typeof config === 'object' && 'connectorSignalling' in config
        ? config.connectorSignalling
        : undefined
    const enabled = signallingBuildEnabled(signalling)
    if (signalling === undefined)
      Object.assign(nuxt.options.runtimeConfig, {
        connectorSignalling: { enabled: false },
      })
    nuxt.hook('nitro:config', (nitro) => {
      const preset = nitro.preset ?? 'node-server'
      if (enabled && preset !== 'node-server')
        throw new Error('Signalling supports only the node-server preset')
      nitro.replace = {
        ...nitro.replace,
        'import.meta._open3dfarmSignallingBuild': JSON.stringify(enabled),
        'import.meta._open3dfarmSignallingPreset': JSON.stringify(preset),
      }
      if (enabled)
        nitro.experimental = { ...nitro.experimental, websocket: true }
    })
  },
})
