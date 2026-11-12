import { createLogger } from '@open3dfarmmanager/shared'

const log = createLogger('farm-server')

/** Structured, redacted logging of unhandled server errors. */
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('error', (error, context) => {
    log.error('unhandled-error', { error, path: context.event?.path })
  })
})
