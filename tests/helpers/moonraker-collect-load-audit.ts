import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'bufferutil' || specifier === 'utf-8-validate') {
      if (process.env.OPEN3D_LOAD_AUDIT)
        appendFileSync(process.env.OPEN3D_LOAD_AUDIT, 'addon-request\n')
      throw new Error('Optional native addon was requested')
    }
    if (specifier === 'ws') {
      if (
        process.env.WS_NO_BUFFER_UTIL !== '1' ||
        process.env.WS_NO_UTF_8_VALIDATE !== '1'
      )
        throw new Error('WebSocket addon policy loaded too late')
      if (process.env.OPEN3D_LOAD_AUDIT)
        appendFileSync(process.env.OPEN3D_LOAD_AUDIT, 'ws-safe\n')
    }
    return nextResolve(specifier, context)
  },
})
