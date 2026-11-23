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
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { withCollectionHold } from '../../packages/connector/src/control/queue-collection-hold.ts'
import { openQueueCollectionJournal } from '../../packages/connector/src/control/queue-collection-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'

function record(resource: string, state: 'created' | 'removed') {
  const ledger = process.env.MOONRAKER_TEST_LEDGER
  if (ledger) appendFileSync(ledger, JSON.stringify({ resource, state }) + '\n')
}

test('signed starts refuse unresolved dispatch and recheck collection after staging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'integration-dispatch-'))
  record(directory, 'created')
  let wall = Date.now()
  const journal = openCommandJournal({ directory, clock: () => wall })
  try {
    const mock = await startMoonrakerMock({ initial: { state: 'standby' } })
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
      const printerKey = 'moonraker'
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
      const collection = openQueueCollectionJournal(
        join(directory, 'collection.json'),
      )
      const filename = 'part.gcode'
      let stages = 0
      let competingFinish = false
      const driver = withCollectionHold(
        {
          controls: () => ['start_print'],
          async pauseOnce() {
            return { acknowledged: false }
          },
          async waitForPaused() {
            return null
          },
          async execute(_action, _args, request) {
            if (competingFinish) {
              collection.dispatched(printerKey, wall)
              mock.control.completePrint()
              collection.finished(printerKey, wall)
            }
            if (!request.beforeSend()) return { acknowledged: false }
            const response = await fetch(
              new URL('/printer/print/start', mock.origin),
              {
                method: 'POST',
                body: JSON.stringify({ filename }),
                signal: request.signal,
              },
            )
            return { acknowledged: response.ok }
          },
        } satisfies import('../../packages/connector/src/control/pause-dispatcher.ts').PauseDriver,
        {
          journal: collection,
          printerKey: () => printerKey,
          clock: () => wall,
          requireInitialClearance: () => true,
        },
      )
      const runner = createApiCommandRunner({
        farmId,
        agentId,
        journal,
        driver,
        keys: { issuer: () => pair.publicKey },
        printer: () => binding,
        observe: () => ({
          ready: true,
          printState:
            mock.control.model().state === 'printing' ? 'printing' : 'idle',
        }),
        clock: { wallNow: () => wall, monotonicNow: () => wall },
        grants: {
          lookup: () => ({
            grant_id: grantId,
            app_id: appId,
            farm_id: farmId,
            revoked: false,
            scopes: ['jobs:write', 'plates:confirm'],
          }),
          freshness: { freshAt: () => true },
        },
        report() {},
        jobFiles: {
          directory,
          targetFor: () => ({ backend: 'moonraker', origin: mock.origin }),
        },
        libraryPrint: {
          async start({ authorize, start }) {
            if (!authorize())
              return { ok: false, code: 'unsupported', message: 'Refused' }
            stages++
            await start(filename, {})
            return { ok: true, source: 'local', name: filename }
          },
        },
      })

      async function start(
        action: import('../../packages/farm-protocol/src/api-envelope.ts').ApiEnvelopeAction = {
          action: 'start_library_print',
          args: { sha256: 'a'.repeat(64) },
        },
      ) {
        wall += 10_000
        return runner.run(
          encodeApiEnvelopeFrame({
            v: 1,
            t: 'api-envelope.command',
            envelope: await signApiEnvelope(
              {
                v: 1,
                purpose: 'api-envelope',
                issuer: API_ENVELOPE_ISSUER,
                kid: 'test',
                app_id: appId,
                grant_id: grantId,
                farm_id: farmId,
                agent_id: agentId,
                assignment_id: assignmentId,
                resource_id: randomUUID(),
                cmd_id: randomUUID(),
                nonce: newApiEnvelopeNonce(),
                issued_at: wall,
                expires_at: wall + 30_000,
                kind: 'action',
                action,
              },
              pair.privateKey,
            ),
          }),
        )
      }

      expect(await start()).toMatchObject({
        kind: 'refused',
        detail: 'plate-state-uncertain',
      })
      expect(stages).toBe(0)
      const initial = {
        action: 'confirm_collection',
        args: { attempt: '0' },
      } as const
      expect(await start(initial)).toEqual({ kind: 'completed' })
      expect(await start(initial)).toEqual({ kind: 'completed' })
      expect(await start()).toEqual({ kind: 'completed' })
      expect(mock.control.model().state).toBe('printing')
      expect(await start()).toMatchObject({
        kind: 'refused',
        detail: 'plate-state-uncertain',
      })
      mock.control.completePrint()
      collection.finished(printerKey, wall)
      expect(await start()).toMatchObject({
        kind: 'refused',
        detail: 'awaiting-collection',
      })
      expect(await start(initial)).toMatchObject({
        kind: 'refused',
        detail: 'plate-attempt-mismatch',
      })
      expect(stages).toBe(1)
      const [attempt] = collection.awaiting(printerKey)
      collection.confirm(printerKey, attempt!)
      collection.confirm(printerKey, attempt!)
      competingFinish = true
      expect(await start()).toMatchObject({
        kind: 'refused',
        detail: 'awaiting-collection',
      })
      expect(stages).toBe(2)
      expect(mock.control.model().state).toBe('complete')
      expect(mock.calls()['HTTP POST /printer/print/start']).toBe(1)
    } finally {
      await mock.close()
      record(mock.origin, 'removed')
    }
  } finally {
    closeCommandJournal(journal)
    await rm(directory, { recursive: true, force: true })
    record(directory, 'removed')
  }
})
