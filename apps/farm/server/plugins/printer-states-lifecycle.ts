import { closePrinterStatesRuntime } from '../utils/printer-states/runtime.ts'
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closePrinterStatesRuntime)
})
