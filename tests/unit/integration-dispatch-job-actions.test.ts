// spec-derived, not captured — https://moonraker.readthedocs.io/en/latest/external_api/printer/
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  API_ENVELOPE_ISSUER,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  scopeForApiAction,
  signApiEnvelope,
  type ApiEnvelopeAction,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { withCollectionHold } from '../../packages/connector/src/control/queue-collection-hold.ts'
import { openQueueCollectionJournal } from '../../packages/connector/src/control/queue-collection-journal.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'
import { openApiJobLifecycle } from '../../packages/connector/src/runtime/api-job-lifecycle.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'

function record(resource: string, state: 'created' | 'removed') {
  const ledger = process.env.MOONRAKER_TEST_LEDGER
  if (ledger) appendFileSync(ledger, JSON.stringify({ resource, state }) + '\n')
}

test.each([false, true])(
  'signed job actions and plate state guard (guard case: %s)',
  async (guardCase) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'integration-dispatch-actions-'),
    )
    record(directory, 'created')
    const journal = openCommandJournal({ directory, clock: Date.now })
    try {
      const mock = await startMoonrakerMock({
        initial: { state: 'standby' },
        clockedPrintDuration: true,
      })
      record(mock.origin, 'created')
      try {
        const pair = await crypto.subtle.generateKey('Ed25519', false, [
          'sign',
          'verify',
        ])
        const farmId = randomUUID()
        const agentId = randomUUID()
        const grantId = randomUUID()
        const appId = randomUUID()
        const assignmentId = randomUUID()
        const printerKey = 'simulated'
        const filename = 'part.gcode'
        const collection = openQueueCollectionJournal(
          join(directory, 'collection.json'),
        )
        const lifecyclePath = join(directory, 'jobs.json')
        let apiJobs = openApiJobLifecycle({ path: lifecyclePath })
        const clock = {
          wallNow: Date.now,
          monotonicNow: () => performance.now(),
        }
        const registry = createPrinterBindingRegistry({
          allowedOrigins: [mock.origin],
        })
        const binding = registry.provision({
          assignment_id: assignmentId,
          farm_id: farmId,
          agent_id: agentId,
          printer_key: printerKey,
          moonraker_origin: mock.origin,
        })
        let observed: ControlObservation | null = null
        const router = createPauseDriverRouter({
          allowedOrigins: [mock.origin],
          limits: {
            maxMessageBytes: 4096,
            connectTimeoutMs: 500,
            requestTimeoutMs: 500,
            staleAfterMs: 2000,
            reconnectMinMs: 100,
            reconnectMaxMs: 100,
          },
          clock,
          observe(_binding, next) {
            observed = next
            return true
          },
        })
        const driver = withCollectionHold(router, {
          journal: collection,
          printerKey: () => printerKey,
        })
        let loseConfirmation = false
        let scopes = ['control:basic', 'plates:confirm']
        function makeRunner() {
          return createApiCommandRunner({
            farmId,
            agentId,
            journal,
            driver,
            apiJobs,
            clock,
            keys: { issuer: () => pair.publicKey },
            printer: () => binding,
            observe: () => observed,
            grants: {
              lookup: () => ({
                grant_id: grantId,
                app_id: appId,
                farm_id: farmId,
                revoked: false,
                scopes,
              }),
              freshness: { freshAt: () => true },
            },
            async confirmEffect({ action }, { sentMono, signal }) {
              if (loseConfirmation) return false
              const before = observed!
              const after = await router.waitForPaused({
                binding,
                signal,
                action: action as 'pause' | 'resume' | 'cancel',
                after: {
                  sequence: before.sequence,
                  connectionGeneration: before.connectionGeneration,
                  sentMono,
                },
              })
              return after !== null
            },
            report() {},
          })
        }
        let runner = makeRunner()
        const wire = async (action: ApiEnvelopeAction) => {
          const issuedAt = Date.now()
          return encodeApiEnvelopeFrame({
            v: 1,
            t: 'api-envelope.command',
            envelope: await signApiEnvelope(
              {
                v: 1,
                purpose: 'api-envelope',
                issuer: API_ENVELOPE_ISSUER,
                kind: 'action',
                kid: 'test',
                app_id: appId,
                grant_id: grantId,
                farm_id: farmId,
                agent_id: agentId,
                assignment_id: assignmentId,
                resource_id: randomUUID(),
                cmd_id: randomUUID(),
                nonce: newApiEnvelopeNonce(),
                issued_at: issuedAt,
                expires_at: issuedAt + 20_000,
                scope: scopeForApiAction(action.action),
                grant_epoch: issuedAt,
                action,
              },
              pair.privateKey,
            ),
          })
        }
        const observeRun = async () => {
          const response = await fetch(
            new URL(
              '/printer/objects/query?print_stats=state,filename,total_duration',
              mock.origin,
            ),
          )
          expect(response.ok).toBe(true)
          const { result } = await response.json()
          const at = Date.now()
          const stats = result.status.print_stats
          apiJobs.observe({
            printerKey,
            epoch: 1,
            printer: { printerKey, observedAt: at, state: 'printing' },
            status: {
              webhooks: { state: 'ready' },
              print_stats: stats,
              virtual_sdcard: { progress: 0 },
            },
            fieldObservedAtMonoMs: { webhooks: 1, printState: 1, progress: 1 },
            receivedAtMonoMs: 1,
            durationSourceTime: result.eventtime,
          })
        }
        const beginRun = async () => {
          const id = randomUUID()
          const at = Date.now()
          const watch = apiJobs.watch(printerKey, filename, id, at - 30_000, 0)
          watch.confirm()
          collection.dispatched(printerKey, at - 30_000)
          mock.control.update({
            state: 'printing',
            filename,
          })
          await observeRun()
          return id
        }

        const first = await beginRun()
        const late = await wire({
          action: 'job_cancel',
          args: { expectedRunId: first },
        })
        mock.control.completePrint()
        const endedAt = Date.now()
        collection.finished(printerKey, endedAt)
        expect(await runner.run(late)).toMatchObject({
          kind: 'refused',
          detail: 'already-ended',
        })

        const plate: ApiEnvelopeAction = {
          action: 'confirm_collection',
          args: { attempt: String(endedAt) },
        }
        scopes = ['control:basic']
        expect(await runner.run(await wire(plate))).toMatchObject({
          kind: 'refused',
          code: 'grant-revoked',
        })
        scopes.push('plates:confirm')
        expect(await runner.run(await wire(plate))).toEqual({
          kind: 'completed',
        })
        expect(await runner.run(await wire(plate))).toEqual({
          kind: 'completed',
        })
        expect(collection.awaiting(printerKey)).toEqual([])
        if (guardCase) {
          for (const printState of ['printing', 'paused'] as const) {
            mock.control.update({ state: printState, filename })
            expect(await runner.run(await wire(plate))).toMatchObject({
              kind: 'refused',
              detail: 'plate-state-uncertain',
            })
          }

          return
        }

        // The fresh socket sees another run of the same filename before the
        // independent lifecycle subscription has observed the first run end.
        mock.control.update({ state: 'printing', filename })
        expect(
          await runner.run(
            await wire({
              action: 'job_cancel',
              args: { expectedRunId: first },
            }),
          ),
        ).toMatchObject({ kind: 'refused', detail: 'run-mismatch' })
        apiJobs.record({
          printerKey,
          state: 'idle',
          observedAt: endedAt,
          lastJob: { filename, outcome: 'completed', endedAt },
        })
        const second = await beginRun()
        expect(await runner.run(await wire(plate))).toMatchObject({
          kind: 'refused',
          detail: 'plate-state-uncertain',
        })
        expect(mock.calls()['printer.print.cancel'] ?? 0).toBe(0)

        // Reopen the durable lifecycle and require a new observation before a send.
        apiJobs = openApiJobLifecycle({ path: lifecyclePath })
        runner = makeRunner()
        expect(
          await runner.run(
            await wire({
              action: 'job_pause',
              args: { expectedRunId: second },
            }),
          ),
        ).toMatchObject({ kind: 'refused', detail: 'run-mismatch' })
        await observeRun()
        expect(
          await runner.run(
            await wire({
              action: 'job_pause',
              args: { expectedRunId: second },
            }),
          ),
        ).toEqual({ kind: 'completed' })
        expect(
          await runner.run(
            await wire({
              action: 'job_resume',
              args: { expectedRunId: second },
            }),
          ),
        ).toEqual({ kind: 'completed' })

        loseConfirmation = true
        const uncertain = await wire({
          action: 'job_cancel',
          args: { expectedRunId: second },
        })
        expect(await runner.run(uncertain)).toEqual({ kind: 'outcome-unknown' })
        expect(await runner.run(uncertain)).toMatchObject({
          kind: 'dropped',
          reason: 'replay',
        })
        expect(
          await runner.run(
            await wire({
              action: 'job_cancel',
              args: { expectedRunId: second },
            }),
          ),
        ).toMatchObject({ kind: 'refused', code: 'printer-busy' })
        expect(mock.calls()['printer.print.cancel']).toBe(1)
      } finally {
        await mock.close()
        record(mock.origin, 'removed')
      }
    } finally {
      closeCommandJournal(journal)
      await rm(directory, { recursive: true, force: true })
      record(directory, 'removed')
    }
  },
)
