import { logUnhandledError } from '../utils/log-unhandled-error.ts'

/** Structured, redacted logging of unhandled server errors. */
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('error', (error, context) =>
    logUnhandledError(error, context?.event),
  )
})
