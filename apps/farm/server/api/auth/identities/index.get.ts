import { defineEventHandler } from 'nuxt/server'
import { listAccountIdentities } from '../../../utils/identity-http.ts'

export default defineEventHandler((event) => listAccountIdentities(event))
