import { defineEventHandler } from 'nuxt/server'
import { googleStatus } from '../../../utils/google-http.ts'

export default defineEventHandler((event) => googleStatus(event))
