import { spoolFeedBus } from '../utils/spool-library/events.ts'
import { closeSpoolLibraryRuntime } from '../utils/spool-library/runtime.ts'

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', async () => {
    spoolFeedBus.closeAll()
    await closeSpoolLibraryRuntime()
  })
})
