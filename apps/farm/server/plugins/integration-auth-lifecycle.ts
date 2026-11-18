import { closeIntegrationAuthRuntime } from '../utils/integration-auth-runtime.ts'

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closeIntegrationAuthRuntime)
})
