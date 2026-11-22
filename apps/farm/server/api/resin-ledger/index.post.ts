import { defineEventHandler } from 'nuxt/server'
import { recordResinLedger } from '../../utils/resin-ledger/service.ts'
export default defineEventHandler((event) => recordResinLedger(event))
