import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { libraryJobFileUrl } from '../../apps/farm/server/services/integration-library.ts'
import { IntegrationApprovalService } from '../../apps/farm/server/services/integration-approval.ts'
import { IntegrationAuditService } from '../../apps/farm/server/services/integration-audit.ts'
import { IntegrationDeliveryService } from '../../apps/farm/server/services/integration-delivery.ts'
import { PostgresIntegrationAudit } from '../../apps/farm/server/storage/integration-audit-postgres.ts'
import { PostgresIntegrationDelivery } from '../../apps/farm/server/storage/integration-delivery-postgres.ts'
import {
  decodeApiEnvelopeFrame,
  encodeApiEnvelopeResultFrame,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  jobRequestHash,
  jobView,
} from '../../apps/farm/server/services/integration-jobs.ts'
import { PostgresIntegrationApprovals } from '../../apps/farm/server/storage/integration-approval-postgres.ts'
import { PostgresIntegrationJobs } from '../../apps/farm/server/storage/integration-jobs-postgres.ts'
import { PostgresIntegrationLibrary } from '../../apps/farm/server/storage/integration-library-postgres.ts'
import {
  disposablePostgres,
  findPostgresBin,
} from '../helpers/disposable-postgres.ts'
import { acceptedArtifact } from '../fixtures/resin-artifacts/contracts.ts'

let postgresReady = false
try {
  if (process.env.OPENFARM_PG !== 'docker') findPostgresBin()
  postgresReady = true
} catch {
  // The unit suite also runs on hosts with no PostgreSQL executable.
}

it.skipIf(!postgresReady)(
  'resolves a held resin replay from immutable metadata on the existing schema',
  async () => {
    const ledgerPath = process.env.OPENFARM_RESIN_ARTIFACT_TEST_LEDGER
    const database = disposablePostgres({
      ...vitestPostgresOptions('openfarm-resin-artifact-storage'),
      isolated: true,
      ledger(event) {
        if (ledgerPath) appendFileSync(ledgerPath, JSON.stringify(event) + '\n')
      },
    })
    try {
      const sql = await database.start()
      const now = Date.now()
      const owner = `owner_${randomUUID().replaceAll('-', '')}`
      const farm = randomUUID()
      const agent = randomUUID()
      const printer = randomUUID()
      const app = randomUUID()
      const grant = randomUUID()
      await sql`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
      await sql`INSERT INTO farm.farms (id, sandbox) VALUES (${farm}, false)`
      await sql`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}, ${owner}, 'owner')`
      await sql`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint)
      VALUES (${agent}, ${farm}, ${'k'.repeat(59)}, ${'resin-artifact'.padEnd(50, 'f')})`
      await sql`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}`
      await sql`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by)
      VALUES (${printer}, ${farm}, ${agent}, 'resin-artifact-fixture', 1, ${owner})`
      await sql`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by)
      VALUES (${app}, ${farm}, 'resin artifact fixture', false, 1, ${owner})`
      await sql`INSERT INTO farm.integration_app_grants
      (id, app_id, farm_id, printer_assignment_id, scopes, requires_approval, created_at, created_by)
      VALUES (${grant}, ${app}, ${farm}, ${printer}, ARRAY['jobs:start','jobs:write'], true, 1, ${owner})`

      const versionId = randomUUID()
      const artifact = {
        fileUrl: libraryJobFileUrl(versionId),
        libraryVersionId: versionId,
        sha256: 'ab'.repeat(32),
        sizeBytes: 42,
        displayName: acceptedArtifact.filename,
        resinProfile: acceptedArtifact.profile,
        plate: 1,
        storageMode: 'server',
      } as const
      const library = new PostgresIntegrationLibrary(sql)
      const item = await library.addVersion({
        id: versionId,
        itemId: randomUUID(),
        farmId: farm,
        title: 'resin artifact fixture',
        originalName: artifact.displayName,
        kind: 'resin',
        resinProfile: artifact.resinProfile,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        plateCount: 1,
        storageLocation: 'server',
        agentId: null,
        createdAt: now,
        versionNumber: 1,
      })
      expect(item.latest).toMatchObject({
        kind: 'resin',
        resinProfile: artifact.resinProfile,
      })
      expect(await library.version(versionId)).toMatchObject({
        resinProfile: artifact.resinProfile,
      })
      const jobs = new PostgresIntegrationJobs(sql)
      const job = {
        ...artifact,
        id: randomUUID(),
        appId: app,
        grantId: grant,
        farmId: farm,
        printerAssignmentId: printer,
        idempotencyKey: 'resin-artifact-held',
        requestHash: jobRequestHash(printer, artifact),
        status: 'held',
      } as const
      expect(await jobs.create(job, now)).toMatchObject({ kind: 'created' })
      expect(
        await jobs.create({ ...job, id: randomUUID() }, now),
      ).toMatchObject({
        kind: 'existing',
        record: { id: job.id, resinProfile: artifact.resinProfile },
      })
      const pair = await crypto.subtle.generateKey('Ed25519', false, [
        'sign',
        'verify',
      ])
      const deliveryStore = new PostgresIntegrationDelivery(sql)
      const sent: string[] = []
      const delivery = new IntegrationDeliveryService({
        store: deliveryStore,
        inbox: {
          sendToAgentInbox(_farm, _agent, wire) {
            sent.push(wire)
            return 'sent'
          },
        },
        audit: new IntegrationAuditService(
          new PostgresIntegrationAudit(sql),
          () => now,
        ),
        signer: { kid: 'resin-fixture', signingKey: pair.privateKey },
        now: () => now,
      })
      const approvals = new IntegrationApprovalService({
        store: new PostgresIntegrationApprovals(sql),
        envelopes: {
          issue: (input) => delivery.issue(input),
          deliver: (id) => delivery.deliver(id),
          get: (id) => deliveryStore.get(id),
        },
        now: () => now,
      })
      expect(
        await approvals.decide(owner, farm, job.id, 'approve'),
      ).toMatchObject({ ok: true })
      const { envelope } = decodeApiEnvelopeFrame(sent[0])
      expect(envelope).toMatchObject({
        action: {
          action: 'start_library_print',
          args: {
            versionId,
            sha256: artifact.sha256,
            profile: artifact.resinProfile,
            plate: 1,
          },
        },
      })
      expect(
        await delivery.recordResult(
          farm,
          agent,
          encodeApiEnvelopeResultFrame({
            v: 1,
            t: 'api-envelope.result',
            cmd_id: envelope.cmd_id,
            outcome: 'refused',
            refusal_code: 'unsupported',
            detail: 'resin-artifact-dispatch-unavailable',
            at: now,
          }),
        ),
      ).toBe('recorded')

      await sql`UPDATE farm.library_versions SET deleted_at = ${now} WHERE id = ${versionId}`
      expect(await library.version(versionId)).toBeNull()
      const receipt = await jobs.get(job.id, app)
      expect(
        receipt && jobView(receipt.record, receipt.envelope),
      ).toMatchObject({
        libraryVersionId: versionId,
        sha256: artifact.sha256,
        resinProfile: artifact.resinProfile,
        status: 'refused',
        refusal: {
          code: 'unsupported',
          detail: 'resin-artifact-dispatch-unavailable',
        },
      })
    } finally {
      await database.stop()
    }
  },
  30_000,
)
