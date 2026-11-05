import { closeAuthRuntime } from '../utils/auth/runtime.ts'
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closeAuthRuntime)
})
