// Factories for vi.mock: they replace only the runtime seams that would open
// PostgreSQL pools or a Connector socket, and hand the handlers the active
// in-memory world instead. Every handler, service and the authorizing
// middleware stay real.
import { currentWorld } from './world.ts'

export const nuxtServer = () => ({
  defineEventHandler: <T>(handler: T) => handler,
  useRuntimeConfig: () => currentWorld().config,
})

export const authRuntime = () => ({
  integrationAuthRuntime: () => currentWorld().auth,
  integrationAuthPool: () => currentWorld().pool,
})

export const spoolUsage = async (
  importOriginal: () => Promise<Record<string, unknown>>,
) => ({
  ...(await importOriginal()),
  integrationSpoolPool: async () => currentWorld().pool,
})

export const jobsRuntime = async () => ({
  integrationJobsRuntime: async () => {
    const world = currentWorld()
    if (world.faults.has('jobs-runtime')) throw new Error('jobs runtime down')
    return { service: world.jobs, actions: world.actions }
  },
  integrationLibraryRuntime: async () => {
    const world = currentWorld()
    if (world.faults.has('library-runtime'))
      throw new Error('library runtime down')
    return { service: world.library }
  },
})

export const signalling = () => ({
  signallingRuntime: () => ({
    queryAgentInbox: (farmId: string, agentId: string, query: unknown) =>
      currentWorld().queryAgentInbox(farmId, agentId, query),
  }),
})

export const webhookStorage = async (
  importOriginal: () => Promise<Record<string, unknown>>,
) => ({
  ...(await importOriginal()),
  PostgresWebhooks: class {
    constructor() {
      return currentWorld().webhooks
    }
  },
})
