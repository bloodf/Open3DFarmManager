import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { spoolMoves } from '../../../../../../services/spool-moves.ts'
export default defineEventHandler((event) =>
  spoolMoves(
    event,
    getRouterParam(event, 'farmId'),
    getRouterParam(event, 'id'),
    'move',
  ),
)
