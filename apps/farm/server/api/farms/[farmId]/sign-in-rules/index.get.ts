import { defineEventHandler } from 'nuxt/server'
import { signInRulesRoute } from '../../../../services/sign-in-rules.ts'
export default defineEventHandler((event) => signInRulesRoute(event, false))
