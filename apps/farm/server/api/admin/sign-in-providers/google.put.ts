import { defineEventHandler } from 'nuxt/server'
import { signInProvidersGooglePut } from '../../../services/sign-in-providers.ts'

export default defineEventHandler((event) => signInProvidersGooglePut(event))
