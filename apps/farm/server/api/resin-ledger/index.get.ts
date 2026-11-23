import { defineEventHandler, getQuery } from 'nuxt/server'
import { listResinLedger } from '../../utils/resin-ledger/service.ts'
export default defineEventHandler((event) =>
  listResinLedger(event, getQuery(event)),
)
