import { describe, expect, it, vi } from 'vitest'
import { IntegrationJobsService } from '../../apps/farm/server/services/integration-jobs.ts'
import { IntegrationActionsService } from '../../apps/farm/server/services/integration-actions.ts'
import type { IntegrationGrant } from '../../apps/farm/server/services/integration-apps.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'

const farmId = '11111111-1111-4111-8111-111111111111'
const printerId = '22222222-2222-4222-8222-222222222222'
const appId = '33333333-3333-4333-8333-333333333333'
const versionId = '44444444-4444-4444-8444-444444444444'
const grant = (
  id: string,
  scopes: IntegrationGrant['scopes'],
  requiresApproval: boolean,
): IntegrationGrant => ({
  id,
  appId,
  farmId,
  printerAssignmentId: printerId,
  scopes,
  requiresApproval,
  createdAt: 1,
  disabledAt: null,
  disabledReason: null,
})

describe('integration replay grant and actions', () => {
  it('holds a library replay when the combined grant requires approval', async () => {
    const startGrant = grant('start-grant', ['jobs:start'], false)
    const writeGrant = grant('write-grant', ['jobs:start', 'jobs:write'], true)
    const created: { grantId: string; status: string }[] = []
    const issued: { grantId: string }[] = []
    const service = new IntegrationJobsService({
      store: {
        target: async () => ({ farmId, agentId: 'agent' }),
        create: async (job) => {
          created.push({ grantId: job.grantId, status: job.status })
          return {
            kind: 'created',
            record: { ...job, createdAt: 1, updatedAt: 1 },
          }
        },
        get: async () => null,
      },
      library: {
        version: async () => ({
          id: versionId,
          farmId,
          sha256: 'ab'.repeat(32),
          sizeBytes: 12,
          displayName: 'part.gcode',
          plateCount: 1,
          storageMode: 'connector',
        }),
        recordReplay: async () => undefined,
      },
      envelopes: {
        issue: async (input) => {
          issued.push({ grantId: input.grantId })
          throw new Error('held replay must not issue an envelope')
        },
        deliver: async () => 'sent',
        get: async () => null,
      },
    })
    const principal: IntegrationPrincipal = {
      appId,
      scopes: ['jobs:start', 'jobs:write'],
      grants: [startGrant, writeGrant],
    }

    const result = await service.submit(principal, printerId, 'replay-1', {
      libraryVersionId: versionId,
    })

    expect(result).toMatchObject({ ok: true, job: { status: 'held' } })
    expect(created).toEqual([{ grantId: 'write-grant', status: 'held' }])
    expect(issued).toEqual([])
  })

  it('refuses start_library_print on the integration actions endpoint', async () => {
    const create = vi.fn()
    const service = new IntegrationActionsService({
      store: {
        target: async () => ({
          farmId,
          agentId: 'agent',
          controls: ['start_library_print'],
        }),
        existing: async () => null,
        create,
        get: async () => null,
      },
      envelopes: {
        issue: async () => {
          throw new Error(
            'start_library_print must not issue an action envelope',
          )
        },
        deliver: async () => 'sent',
        get: async () => null,
      },
    })
    const principal: IntegrationPrincipal = {
      appId,
      scopes: ['control:extended'],
      grants: [grant('control-grant', ['control:extended'], false)],
    }

    const result = await service.submit(principal, printerId, 'action-1', {
      action: 'start_library_print',
      args: { sha256: 'ab'.repeat(32) },
    })

    expect(result).toEqual({ ok: false, problem: 'unsupported' })
    expect(create).not.toHaveBeenCalled()
  })
})
