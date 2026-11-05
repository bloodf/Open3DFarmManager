import { closePrinterAssignmentsRuntime } from '../utils/printer-assignments/runtime.ts'
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closePrinterAssignmentsRuntime)
})
