import { useRuntimeConfig } from 'nuxt/server'
import {
  closeIntegrationAuthRuntime,
  integrationAuthPool,
} from '../utils/integration-auth-runtime.ts'
import { PostgresWebhooks } from '../storage/webhook-postgres.ts'
import { deliverNextWebhook } from '../services/webhook-worker.ts'
import { credentialKeyring } from '../utils/sealed-credential-key.ts'

export default defineNitroPlugin((nitro) => {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let active = Promise.resolve()
  function schedule(delay: number) {
    timer = setTimeout(() => {
      active = tick()
    }, delay)
    timer.unref()
  }
  async function tick() {
    let worked = false
    try {
      worked = await deliverNextWebhook(
        new PostgresWebhooks(
          integrationAuthPool(),
          credentialKeyring(useRuntimeConfig().auth),
        ),
      )
    } catch {
      // The lease makes an interrupted delivery available again.
    }
    if (!stopped) schedule(worked ? 0 : 1000)
  }
  if (useRuntimeConfig().integrationAuth.enabled === true) schedule(1000)
  nitro.hooks.hook('close', async () => {
    stopped = true
    clearTimeout(timer)
    await active
    await closeIntegrationAuthRuntime()
  })
})
