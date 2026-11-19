import { defineEventHandler } from 'nuxt/server'
import { googleLinkStartGet } from '../../../../utils/google-http.ts'

export default defineEventHandler((event) => googleLinkStartGet(event))
