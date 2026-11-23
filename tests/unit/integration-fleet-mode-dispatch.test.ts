import { expect, it, vi } from 'vitest'

const id = '22222222-2222-4222-8222-222222222222'
const farm = '11111111-1111-4111-8111-111111111111'
const mode = vi.hoisted(() => ({ value: 'maintenance' }))
vi.mock('../../apps/farm/server/utils/integration-jobs-runtime.ts', () => ({
  integrationJobsRuntime: async () => ({
    service: {
      get: async () => ({
        id: 'job',
        farmId: farm,
        printerId: id,
        status: 'queued',
      }),
    },
  }),
}))
vi.mock('../../apps/farm/server/utils/integration-auth-runtime.ts', () => ({
  integrationAuthPool: () => ({}),
  integrationAuthRuntime: () => ({
    store: {
      readPrinter: async () => ({ id, farmId: farm, agentId: 'agent' }),
    },
  }),
}))
vi.mock('../../apps/farm/server/storage/fleet-mode-postgres.ts', () => ({
  PostgresFleetMode: class {
    async read() {
      return { mode: mode.value }
    }
  },
}))
vi.mock(
  '../../apps/farm/server/services/signalling-runtime-bootstrap.ts',
  () => ({
    signallingRuntime: () => ({
      queryAgentInbox: async () => ({
        kind: 'dispatch',
        data: [
          {
            printerState: 'idle',
            plateState: 'operator-confirmed',
            observedAt: 1,
          },
        ],
      }),
    }),
  }),
)
import { readIntegrationDispatch } from '../../apps/farm/server/utils/integration-jobs-dispatch.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'

it('marks maintenance ineligible while keeping the plate observation separate', async () => {
  const input = {
    request: new Request(`https://example.invalid/?printerId=${id}`),
    headers: {},
    principal: {} as IntegrationPrincipal,
    jobId: 'job',
    view: 'eligibility' as const,
  }
  expect(await (await readIntegrationDispatch(input)).json()).toMatchObject({
    eligible: false,
    reasons: ['maintenance'],
    plate: { state: 'operator-confirmed' },
  })
  mode.value = 'in-service'
  expect(await (await readIntegrationDispatch(input)).json()).toMatchObject({
    eligible: true,
    reasons: [],
  })
})
