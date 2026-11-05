import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === 'ws' ||
      /moonraker\/(?:client|subscription)\.ts$/.test(specifier) ||
      specifier.includes('authenticated-http-telemetry')
    )
      throw new Error('Pure runtime configuration imported networking')
    return nextResolve(specifier, context)
  },
})
