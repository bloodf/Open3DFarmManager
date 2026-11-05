import { defineEventHandler } from 'nuxt/server'
import { browserDeviceRequest } from '../../services/browser-devices.ts'
import { browserDevicesRuntime } from '../../utils/browser-devices/runtime.ts'
export default defineEventHandler((event) =>
  browserDeviceRequest(event, browserDevicesRuntime(), 'revoke'),
)
