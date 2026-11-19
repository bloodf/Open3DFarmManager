import { defineEventHandler } from 'nuxt/server'
import { unlinkGoogleIdentity } from '../../../utils/identity-http.ts'

export default defineEventHandler((event) => unlinkGoogleIdentity(event))
