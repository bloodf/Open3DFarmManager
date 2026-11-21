import {
  closeSpoolUsageRuntime,
  spoolUsageEnabled,
  spoolUsageRuntime,
} from '../services/spool-usage.ts'

const SWEEP_MS = 30_000
const WINDOW_MS = 24 * 3600_000

/**
 * Records filament usage for finished jobs while the server runs: an in-process
 * timer (no host service) asks the store for jobs without usage yet.
 */
export default defineNitroPlugin((nitro) => {
  let timer: ReturnType<typeof setInterval> | undefined
  let busy = false
  if (spoolUsageEnabled()) {
    timer = setInterval(() => {
      if (busy) return
      busy = true
      void spoolUsageRuntime()
        .then((usage) => usage.sweep({ sinceMs: WINDOW_MS }))
        .catch(() => {})
        .finally(() => {
          busy = false
        })
    }, SWEEP_MS)
    timer.unref?.()
  }
  nitro.hooks.hook('close', async () => {
    if (timer) clearInterval(timer)
    await closeSpoolUsageRuntime()
  })
})
