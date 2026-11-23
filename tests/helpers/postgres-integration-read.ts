import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { IntegrationAuditService } from '../../apps/farm/server/services/integration-audit.ts'
import { IntegrationDeliveryService } from '../../apps/farm/server/services/integration-delivery.ts'
import { IntegrationJobsService } from '../../apps/farm/server/services/integration-jobs.ts'
import { PostgresIntegrationAudit } from '../../apps/farm/server/storage/integration-audit-postgres.ts'
import { PostgresIntegrationDelivery } from '../../apps/farm/server/storage/integration-delivery-postgres.ts'
import { PostgresIntegrationJobs } from '../../apps/farm/server/storage/integration-jobs-postgres.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'
import { submitIntegrationJobRequest } from '../../apps/farm/server/utils/integration-jobs-http.ts'
import {
  listIntegrationInventory,
  listIntegrationJobs,
} from '../../apps/farm/server/utils/integration-read.ts'

const observedAt = 1_700_000_000_000
const endedAt = 1_700_000_000_100

function snapshot(total: number) {
  return {
    observedAt,
    stale: false,
    total,
    spools:
      total === 0
        ? []
        : [
            {
              name: 'PLA',
              material: 'PLA',
              colorHex: 'ff0000',
              remainingGrams: 200,
              location: 'rack',
              archived: false,
            },
          ],
  }
}

/** Migrated disposable database. Caller owns the pool and teardown. */
export async function testPostgresIntegrationRead(sql: Sql) {
  const checks: string[] = []
  const owner = 'owner_' + randomUUID().replaceAll('-', '')
  await sql`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
  const farmId = randomUUID()
  const otherFarmId = randomUUID()
  await sql`INSERT INTO farm.farms (id, sandbox) VALUES (${farmId}, true), (${otherFarmId}, true)`
  const enroll = async (farm: string, key: string) => {
    const agent = randomUUID()
    await sql`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${agent}::uuid, ${farm}::uuid, ${'k'.repeat(59)}, ${key.padEnd(50, 'f')})`
    await sql`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}::uuid`
    const id = randomUUID()
    await sql`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by) VALUES (${id}::uuid, ${farm}::uuid, ${agent}::uuid, ${key}, 1, ${owner})`
    return { agent, id }
  }
  const printer = await enroll(farmId, 'sandbox-printer')
  const other = await enroll(otherFarmId, 'other-printer')
  await sql`INSERT INTO farm.connector_inventory_snapshots (farm_id, agent_id, observed_at, snapshot) VALUES (${farmId}::uuid, ${printer.agent}::uuid, ${observedAt}, ${sql.json(snapshot(1))}), (${otherFarmId}::uuid, ${other.agent}::uuid, ${observedAt}, ${sql.json(snapshot(0))})`
  await sql`INSERT INTO farm.job_history (farm_id, agent_id, printer_key, outcome, filename, print_duration_seconds, total_duration_seconds, ended_at) VALUES (${farmId}::uuid, ${printer.agent}::uuid, 'sandbox-printer', 'completed', 'part.gcode', 10, 12, ${endedAt}), (${otherFarmId}::uuid, ${other.agent}::uuid, 'other-printer', 'failed', 'hidden.gcode', 1, 1, ${endedAt})`

  const inventory = await listIntegrationInventory(sql, {
    farmIds: [farmId],
    limit: 50,
    cursor: null,
  })
  assert.equal(inventory.data.length, 1)
  assert.equal(inventory.data[0]?.farmId, farmId)
  assert.equal(inventory.data[0]?.connectorId, printer.agent)
  assert.equal(inventory.data[0]?.total, 1)
  assert.equal(inventory.nextCursor, null)
  checks.push('inventory read returns the sandbox snapshot')

  const history = await listIntegrationJobs(sql, {
    farmWideFarmIds: [farmId],
    assignmentIds: [],
    printerId: null,
    since: null,
    until: null,
    limit: 50,
    cursor: null,
  })
  assert.equal(history.data.length, 1)
  assert.equal(history.data[0]?.farmId, farmId)
  assert.equal(history.data[0]?.printerId, printer.id)
  assert.equal(history.data[0]?.outcome, 'completed')
  assert.equal(history.data[0]?.filename, 'part.gcode')
  assert.equal(history.data[0]?.endedAt, endedAt)
  assert.equal(history.nextCursor, null)
  checks.push('job history read returns the sandbox job')

  const appId = randomUUID()
  await sql`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by) VALUES (${appId}::uuid, ${farmId}::uuid, 'sandbox', true, 1, ${owner})`
  const grantId = randomUUID()
  const scopes = ['inventory:read', 'jobs:read', 'jobs:start'] as const
  await sql`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, printer_assignment_id, scopes, requires_approval, created_at, created_by) VALUES (${grantId}::uuid, ${appId}::uuid, ${farmId}::uuid, ${null}::uuid, ${scopes}::text[], false, 1, ${owner})`
  const now = 7_000_000
  const pair = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const deliveryStore = new PostgresIntegrationDelivery(sql)
  const delivery = new IntegrationDeliveryService({
    store: deliveryStore,
    inbox: { sendToAgentInbox: () => 'sent' },
    audit: new IntegrationAuditService(
      new PostgresIntegrationAudit(sql),
      () => now,
    ),
    signer: { kid: 'api-1', signingKey: pair.privateKey },
    now: () => now,
  })
  const service = new IntegrationJobsService({
    store: new PostgresIntegrationJobs(sql),
    envelopes: {
      issue: (input) => delivery.issue(input),
      deliver: (id) => delivery.deliver(id),
      get: (id) => deliveryStore.get(id),
    },
    now: () => now,
  })
  const principal: IntegrationPrincipal = {
    appId,
    scopes,
    grants: [
      {
        id: grantId,
        appId,
        farmId,
        printerAssignmentId: null,
        scopes: [...scopes],
        requiresApproval: false,
        createdAt: 1,
        disabledAt: null,
        disabledReason: null,
      },
    ],
  }
  const file = {
    fileUrl: 'https://files.example.invalid/a.gcode',
    sha256: 'cd'.repeat(32),
    sizeBytes: 4096,
    displayName: 'a.gcode',
  }
  const response = await submitIntegrationJobRequest(
    new Request(
      'https://farm.invalid/api/integrations/v1/printers/' +
        printer.id +
        '/jobs',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'sandbox-job-1',
        },
        body: JSON.stringify(file),
      },
    ),
    principal,
    printer.id,
    service,
  )
  const body: {
    id?: string
    farmId?: string
    printerId?: string
    status?: string
    displayName?: string
    fileUrl?: string
    sha256?: string
    sizeBytes?: number
  } = await response.json()
  assert.equal(response.status, 202, JSON.stringify(body))
  assert.equal(body.farmId, farmId)
  assert.equal(body.printerId, printer.id)
  assert.equal(body.status, 'queued')
  assert.equal(body.displayName, file.displayName)
  assert.equal(body.fileUrl, file.fileUrl)
  assert.equal(body.sha256, file.sha256)
  assert.equal(body.sizeBytes, file.sizeBytes)
  assert.equal(
    response.headers.get('location'),
    '/api/integrations/v1/jobs/' + body.id,
  )
  checks.push('sandbox job submit returns 202')
  return checks
}
