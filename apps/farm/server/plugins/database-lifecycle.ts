import { useRuntimeConfig } from 'nuxt/server'
import {
  closeDatabaseRuntime,
  parseDatabaseRuntimeConfig,
  startDatabaseRuntime,
} from '../utils/database/runtime.ts'

export default defineNitroPlugin(async (nitro) => {
  nitro.hooks.hook('close', closeDatabaseRuntime)
  const config = parseDatabaseRuntimeConfig(
    Reflect.get(useRuntimeConfig(), 'database'),
  )
  // Awaited and not caught: a failure here aborts startup so the server never serves.
  if (config) await startDatabaseRuntime(config)
})
