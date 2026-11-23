import { describe, expect, it, vi } from 'vitest'
import { IntegrationJobsService } from '../../apps/farm/server/services/integration-jobs.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'

const farmId = '11111111-1111-4111-8111-111111111111'
const printerId = '22222222-2222-4222-8222-222222222222'
const appId = '33333333-3333-4333-8333-333333333333'
const principal: IntegrationPrincipal = {
  appId,
  scopes: ['jobs:start', 'jobs:write'],
  grants: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      appId,
      farmId,
      printerAssignmentId: printerId,
      scopes: ['jobs:start', 'jobs:write'],
      requiresApproval: false,
      createdAt: 1,
      disabledAt: null,
      disabledReason: null,
    },
  ],
}

describe('maintenance availability', () => {
  it('refuses ordinary jobs and library replays before creating or sending anything', async () => {
    const create = vi.fn(),
      issue = vi.fn(),
      deliver = vi.fn(),
      resolve = vi.fn()
    const service = new IntegrationJobsService({
      store: {
        target: async () => ({ farmId, agentId: 'agent' }),
        create,
        get: async () => null,
      },
      fleetMode: async () => 'maintenance',
      library: { version: resolve, recordReplay: vi.fn() },
      envelopes: { issue, deliver, get: async () => null },
    })
    for (const body of [
      {
        fileUrl: 'https://example.invalid/part.gcode',
        sha256: 'ab'.repeat(32),
        sizeBytes: 12,
        displayName: 'part.gcode',
      },
      { libraryVersionId: '55555555-5555-4555-8555-555555555555' },
    ]) {
      expect(
        await service.submit(principal, printerId, 'test-key', body),
      ).toEqual({
        ok: false,
        problem: 'validation-failed',
        reason: { pointer: '/printerId', detail: 'maintenance' },
      })
    }
    expect(create).not.toHaveBeenCalled()
    expect(issue).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })
})
