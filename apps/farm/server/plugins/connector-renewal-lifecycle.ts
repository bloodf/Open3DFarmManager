import { closeConnectorRenewalRuntime } from '../utils/connector-renewal/runtime.ts'
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closeConnectorRenewalRuntime)
})
