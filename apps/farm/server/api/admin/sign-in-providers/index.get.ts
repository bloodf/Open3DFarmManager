import { defineEventHandler } from 'nuxt/server'
import { signInProvidersGet } from '../../../services/sign-in-providers.ts'

export default defineEventHandler((event) => signInProvidersGet(event))
