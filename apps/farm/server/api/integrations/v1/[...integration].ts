import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../utils/integration-auth-http.ts'

export default defineEventHandler(() => integrationProblem('not-found'))
