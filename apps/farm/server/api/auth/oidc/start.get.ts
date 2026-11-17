import { defineEventHandler } from 'nuxt/server'
import { oidcStartGet } from '../../../utils/oidc-http.ts'

export default defineEventHandler((event) => oidcStartGet(event))
