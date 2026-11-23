import { defineEventHandler } from 'nuxt/server'
import { oidcStartPost } from '../../../utils/oidc-http.ts'

export default defineEventHandler((event) => oidcStartPost(event))
