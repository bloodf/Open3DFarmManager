import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { farmFleetMode } from '../../../../../services/fleet-mode-http.ts'

export default defineEventHandler((event) =>
  farmFleetMode(
    event,
    getRouterParam(event, 'farmId') ?? '',
    getRouterParam(event, 'assignmentId') ?? '',
  ),
)
