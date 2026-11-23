import { defineEventHandler } from 'nuxt/server'
import { oidcStatus } from '../../../utils/oidc-http.ts'

export default defineEventHandler((event) => oidcStatus(event))
