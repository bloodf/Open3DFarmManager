import { defineEventHandler } from 'nuxt/server'
import { pauseAuthorityRequest } from '../../services/pause-authority-http.ts'
import { authResponse } from '../../services/authenticated-session.ts'
import { pauseAuthorityRuntime } from '../../utils/pause-authority/runtime.ts'
export default defineEventHandler((event) => {
  authResponse(event)
  return pauseAuthorityRequest(event, pauseAuthorityRuntime(), 'capabilities')
})
