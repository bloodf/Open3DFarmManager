import { defineEventHandler } from 'nuxt/server'
import { connectorInventory } from '../../services/connector-inventory.ts'
export default defineEventHandler((event) => connectorInventory(event))
