import { defineEventHandler } from 'nuxt/server'
import { login } from '../../services/authenticated-session.ts'
import { authRuntime } from '../../utils/auth/runtime.ts'
export default defineEventHandler((event) => login(event, authRuntime()))
