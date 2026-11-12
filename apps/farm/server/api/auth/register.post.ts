import { defineEventHandler } from 'nuxt/server'
import { registerWithInvite } from '../../services/account-registration.ts'
import { authRuntime } from '../../utils/auth/runtime.ts'
export default defineEventHandler((event) =>
  registerWithInvite(event, authRuntime()),
)
