import { closePrinterStatesRuntime } from '../utils/printer-states/runtime.ts'
import { closeFarmNetworkRuntime } from '../utils/farm-network/runtime.ts'
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closePrinterStatesRuntime)
  nitro.hooks.hook('close', closeFarmNetworkRuntime)
})
