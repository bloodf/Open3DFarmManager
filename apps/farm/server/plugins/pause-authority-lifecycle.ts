import { useRuntimeConfig } from 'nuxt/server'
import { authRuntime } from '../utils/auth/runtime.ts'
import { parsePauseAuthorityRuntimeConfig } from '../utils/pause-authority/config.ts'
import { createPauseAuthorityRuntimeLifecycle } from '../utils/pause-authority/runtime.ts'

export default defineNitroPlugin((nitro) => {
  const lifecycle = createPauseAuthorityRuntimeLifecycle()
  nitro.hooks.hook('close', () => lifecycle.close())
  // Disabled defaults do not read keys or create any database pool.
  const config = parsePauseAuthorityRuntimeConfig(
    Reflect.get(useRuntimeConfig(), 'pauseAuthority'),
  )
  if (!config) return
  void lifecycle.start(config, authRuntime()).catch(() => {
    nitro.captureError(new Error('Pause authority startup unavailable'), {
      tags: ['pause-authority-startup'],
    })
  })
})
