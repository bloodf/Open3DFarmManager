import { defineEventHandler } from 'nuxt/server'
import { oidcCallback } from '../../../utils/oidc-http.ts'

export default defineEventHandler((event) => oidcCallback(event))
