import { defineEventHandler } from 'nuxt/server'
import { googleCallback } from '../../../utils/google-http.ts'

export default defineEventHandler((event) => googleCallback(event))
