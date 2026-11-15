import { defineEventHandler } from 'nuxt/server'
import { jobHistory } from '../../services/job-history.ts'
export default defineEventHandler((event) => jobHistory(event))
