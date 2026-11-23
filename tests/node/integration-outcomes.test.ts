import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IntegrationJobsService,
  jobView,
  jobStatusOf,
  type IntegrationJobsStore,
  type JobRecord,
} from '../../apps/farm/server/services/integration-jobs.ts'
import type { EnvelopeRecord } from '../../apps/farm/server/services/integration-delivery.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'

const appId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const farmId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const printerId = 'aaaaaaaa-0000-4000-8000-000000000001'
const jobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const record: JobRecord = {
  id: jobId,
  appId,
  grantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  farmId,
  printerAssignmentId: printerId,
  idempotencyKey: 'test',
  requestHash: 'hash',
  fileUrl: 'https://files.example.invalid/job.gcode',
  sha256: 'ab'.repeat(32),
  sizeBytes: 10,
  displayName: 'job.gcode',
  status: 'submitted',
  createdAt: 10,
  updatedAt: 10,
}
const principal: IntegrationPrincipal = {
  appId,
  scopes: ['jobs:read'],
  grants: [
    {
      id: record.grantId,
      appId,
      farmId,
      printerAssignmentId: printerId,
      scopes: ['jobs:read'],
      requiresApproval: false,
      createdAt: 1,
      disabledAt: null,
      disabledReason: null,
    },
  ],
}
function envelope(
  status: EnvelopeRecord['status'],
  extra: Partial<EnvelopeRecord> = {},
): EnvelopeRecord {
  return {
    cmdId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    appId,
    grantId: record.grantId,
    farmId,
    agentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    printerAssignmentId: printerId,
    kind: 'job',
    resourceId: jobId,
    requiredScope: 'jobs:start',
    nonce: 'a'.repeat(22),
    wire: 'signed',
    issuedAt: 10,
    expiresAt: 20,
    status,
    refusalCode: null,
    resultDetail: null,
    historyEntryId: null,
    createdAt: 10,
    updatedAt: 11,
    ...extra,
  }
}

test('job outcome reads are derived from Connector results, preserve refusal and history, and only advance', async () => {
  let current = envelope('pending')
  const store: IntegrationJobsStore = {
    async target() {
      return null
    },
    async create() {
      throw new Error('not used')
    },
    async get(id, owner) {
      return id === jobId && owner === appId
        ? { record, envelope: current }
        : null
    },
  }
  const service = new IntegrationJobsService({ store, now: () => 100 })
  assert.equal(jobStatusOf('submitted', null), 'queued')
  const queued = await service.get(principal, jobId)
  assert.ok(!('error' in queued))
  assert.equal(queued.status, 'queued')
  current = envelope('delivered')
  const delivered = await service.get(principal, jobId)
  assert.ok(!('error' in delivered))
  assert.equal(delivered.status, 'delivered')
  current = envelope('refused', {
    refusalCode: 'printer-busy',
    resultDetail: 'busy',
  })
  const refused = await service.get(principal, jobId)
  assert.ok(!('error' in refused))
  assert.equal(refused.status, 'refused')
  if ('refusal' in refused)
    assert.deepEqual(refused.refusal, { code: 'printer-busy', detail: 'busy' })
  else assert.fail('expected refusal reason')
  const completed = jobView(
    record,
    envelope('completed', { historyEntryId: '123' }),
  )
  assert.equal(completed.status, 'completed')
  assert.equal(completed.historyEntryId, '123')
})
