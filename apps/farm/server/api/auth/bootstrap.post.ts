import { defineEventHandler } from 'nuxt/server'
import { bootstrapOwner } from '../../services/account-registration.ts'
import { authRuntime } from '../../utils/auth/runtime.ts'
export default defineEventHandler((event) =>
  bootstrapOwner(event, authRuntime()),
)
