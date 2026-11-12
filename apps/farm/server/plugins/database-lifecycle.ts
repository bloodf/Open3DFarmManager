import { useRuntimeConfig } from 'nuxt/server'
import { beginDatabaseStartup } from '../utils/database/lifecycle.ts'
import { closeDatabaseRuntime } from '../utils/database/runtime.ts'
import { setDatabasePhase } from '../utils/database/phase.ts'

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', async () => {
    setDatabasePhase('failed')
    await closeDatabaseRuntime()
  })
  // Never at build/prerender time: it must not touch a database or exit the build.
  if (import.meta.prerender) return
  void beginDatabaseStartup(useRuntimeConfig())
})
