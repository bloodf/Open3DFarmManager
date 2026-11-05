import { defineEventHandler } from 'nuxt/server'
import { authenticatedSession } from '../../services/authenticated-session.ts'
import { authRuntime } from '../../utils/auth/runtime.ts'
export default defineEventHandler((event) =>
  authenticatedSession(event, authRuntime()),
)
