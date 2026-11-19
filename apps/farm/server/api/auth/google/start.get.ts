import { defineEventHandler } from 'nuxt/server'
import { googleStartGet } from '../../../utils/google-http.ts'

export default defineEventHandler((event) => googleStartGet(event))
