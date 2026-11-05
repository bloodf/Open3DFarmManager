import { closeConnectorPairingRuntime } from '../utils/connector-pairing/runtime.ts'
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closeConnectorPairingRuntime)
})
