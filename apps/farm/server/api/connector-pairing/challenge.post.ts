import { defineEventHandler } from 'nuxt/server'
import { connectorPairing } from '../../services/connector-pairing.ts'
export default defineEventHandler((event) =>
  connectorPairing(event, 'challenge'),
)
