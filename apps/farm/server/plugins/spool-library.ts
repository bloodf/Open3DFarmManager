import { closeSpoolLibraryRuntime } from '../utils/spool-library/runtime.ts'

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closeSpoolLibraryRuntime)
})
