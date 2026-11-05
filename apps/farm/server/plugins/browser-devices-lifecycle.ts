import { closeBrowserDevicesRuntime } from '../utils/browser-devices/runtime.ts'
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closeBrowserDevicesRuntime)
})
