import { createLogger } from '@open3dfarmmanager/shared'
import { useRuntimeConfig } from 'nuxt/server'
import { authRuntime } from '../utils/auth/runtime.ts'
import { PasswordResetRuntime } from '../utils/auth/password-reset-runtime.ts'

const logger = createLogger('farm-server')
const resetPaths =
  /^(\/api\/auth\/password-reset-(request|complete)|\/api\/farms\/[^/]+\/members\/[^/]+\/reset-link)$/

/** Reset is off unless runtimeConfig.auth.passwordReset is exactly true. */
function passwordResetEnabled(config: unknown): boolean {
  return (
    typeof config === 'object' &&
    config !== null &&
    'enabled' in config &&
    config.enabled === true &&
    'passwordReset' in config &&
    config.passwordReset === true
  )
}

/**
 * Enables password reset behind NUXT_AUTH_PASSWORD_RESET. Owners issue one-time
 * links; no email or other delivery is configured, so self-service requests stay off.
 */
export default defineNitroPlugin((nitro) => {
  if (import.meta.prerender) return
  let runtime: PasswordResetRuntime | undefined
  nitro.hooks.hook('request', (event) => {
    if (!resetPaths.test(event.path.split('?')[0] ?? '')) return
    if (!passwordResetEnabled(useRuntimeConfig().auth)) return
    if (!runtime) {
      try {
        const auth = authRuntime()
        if (!auth.passwordReset) return
        runtime = new PasswordResetRuntime(auth, auth.passwordReset)
      } catch (error) {
        logger.error('password-reset-unavailable', { error })
        return
      }
    }
    event.context.passwordReset = runtime
  })
  nitro.hooks.hook('close', async () => {
    await runtime?.close()
    runtime = undefined
  })
})
