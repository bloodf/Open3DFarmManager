import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  IntegrationAuditService,
  safeAuditDetails,
  type IntegrationAuditEntry,
  type IntegrationAuditFilter,
  type IntegrationAuditStore,
} from '../../apps/farm/server/services/integration-audit.ts'

const entry = {
  farmId: '11111111-1111-4111-8111-111111111111',
  appId: '22222222-2222-4222-8222-222222222222',
  printerAssignmentId: null,
  actorKind: 'app' as const,
  actorId: 'integration-app',
  action: 'job.submitted' as const,
  resourceType: 'job' as const,
  resourceId: 'job-1',
  outcome: 'accepted' as const,
}
class MemoryStore implements IntegrationAuditStore {
  rows: IntegrationAuditEntry[] = []
  async append(value: Omit<IntegrationAuditEntry, 'id'>) {
    const saved = { ...value, id: String(this.rows.length + 1) }
    this.rows.push(saved)
    return saved
  }
  async listForOwner(_actor: string, filter: IntegrationAuditFilter) {
    return filter.farmId === entry.farmId ? this.rows : null
  }
}
test('each recorded state change appends one sanitized entry', async () => {
  const store = new MemoryStore()
  const service = new IntegrationAuditService(store, () => 1234)
  for (const action of [
    'job.submitted',
    'printer.action',
    'approval.decided',
    'connector.result',
    'subscription.changed',
    'credential.event',
  ] as const)
    await service.record({
      ...entry,
      action,
      details: {
        status: 'ok',
        accessToken: 'secret',
        fileContents: 'private',
        count: 3,
      },
    })
  assert.equal(store.rows.length, 6)
  assert.deepEqual(store.rows[0]?.details, { status: 'ok', count: 3 })
  assert.equal(store.rows[0]?.occurredAt, 1234)
  assert.equal(JSON.stringify(store.rows).includes('secret'), false)
  assert.equal(JSON.stringify(store.rows).includes('private'), false)
})
test('owner listing delegates farm authorization and accepts app/printer filters', async () => {
  const store = new MemoryStore()
  const service = new IntegrationAuditService(store)
  await service.record({ ...entry })
  assert.equal(
    (
      await service.listForOwner('owner', {
        farmId: entry.farmId,
        appId: entry.appId,
        printerAssignmentId: '33333333-3333-4333-8333-333333333333',
      })
    )?.length,
    1,
  )
  assert.equal(
    await service.listForOwner('not-owner', {
      farmId: '44444444-4444-4444-8444-444444444444',
    }),
    null,
  )
})
test('detail sanitization excludes tokens and file payloads', () => {
  assert.deepEqual(
    safeAuditDetails({ token: 'x', fileName: 'x', status: true, count: 2 }),
    { status: true, count: 2 },
  )
})
