import { closeJobHistoryRuntime } from '../utils/job-history-runtime.ts'
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closeJobHistoryRuntime)
})
