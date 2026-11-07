import { defineEventHandler } from 'nuxt/server'
import { passwordResetHttp } from '../../services/password-reset-http.ts'
export default defineEventHandler((event) => passwordResetHttp(event, false))
