import { closeConnectorInventoryRuntime } from '../utils/connector-inventory/runtime.ts'
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closeConnectorInventoryRuntime)
})
