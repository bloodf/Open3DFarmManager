import { defineEventHandler } from 'nuxt/server'
import { logout } from '../../services/authenticated-session.ts'
import { authRuntime } from '../../utils/auth/runtime.ts'
export default defineEventHandler((event) => logout(event, authRuntime()))
