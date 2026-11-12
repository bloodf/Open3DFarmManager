import { useRuntimeConfig } from 'nuxt/server'
import {
  closeDatabaseRuntime,
  parseDatabaseRuntimeConfig,
  startDatabaseRuntime,
} from '../utils/database/runtime.ts'

export default defineNitroPlugin(async (nitro) => {
  nitro.hooks.hook('close', closeDatabaseRuntime)
  // Fail closed: an invalid config, unreachable database or schema mismatch
  // must stop the process; a rejected plugin alone would still let Nitro listen.
  try {
    const config = parseDatabaseRuntimeConfig(
      Reflect.get(useRuntimeConfig(), 'database'),
    )
    if (config) await startDatabaseRuntime(config)
  } catch (error) {
    console.error(
      'Database startup failed; refusing to serve:',
      error instanceof Error ? error.message : 'unknown error',
    )
    process.exit(1)
  }
})
