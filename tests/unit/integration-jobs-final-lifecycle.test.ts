import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import { expect, test } from 'vitest'
import { listIntegrationJobs } from '../../apps/farm/server/utils/integration-read.ts'
import { PostgresIntegrationJobDelivery } from '../../apps/farm/server/storage/integration-jobs-history.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  API_ENVELOPE_ISSUER,
  decodeApiEnvelopeResultFrame,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'
import {
  collectIntoQueue,
  type Diagnostic,
} from '../../packages/connector/src/runtime/collect.ts'
import type { RawPrinterObservation } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'

function recordResource(id: string | number, state: string) {
  const ledger = process.env.MOONRAKER_TEST_LEDGER
  if (ledger) appendFileSync(ledger, JSON.stringify({ id, state }) + '\n')
}

test.each([
  ['complete', 'completed'],
  ['cancelled', 'cancelled'],
  ['error', 'failed'],
  ['complete', 'uncertain'],
] as const)(
  'a Moonraker %s reports %s and links its own run',
  async (terminal, outcome) => {
    const directory = await mkdtemp(join(tmpdir(), 'openfarm-jobs-final-'))
    recordResource(directory, 'created')
    const mock = await startMoonrakerMock({ initial: { state: 'standby' } })
    recordResource(mock.origin, 'created')
    const cert = await readFile(
      new URL('../fixtures/bambu-ftps/cert.pem', import.meta.url),
    )
    const key = await readFile(
      new URL('../fixtures/bambu-ftps/key.pem', import.meta.url),
    )
    const file = Buffer.from('G28\n')
    const source = createServer({ cert, key }, (_req, res) => res.end(file))
    source.listen(0, '127.0.0.1')
    await once(source, 'listening')
    const address = source.address()
    if (!address || typeof address === 'string')
      throw new Error('Fixture port missing')
    recordResource(address.port, 'created')

    const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
    const journal = openCommandJournal({ directory, clock: Date.now })
    const abort = new AbortController()
    let observation: RawPrinterObservation | undefined
    const diagnostics: Diagnostic[] = []
    const printerKey = 'api-job-fixture'
    const collect = collectIntoQueue({
      queue,
      signal: abort.signal,
      config: {
        version: 1,
        allowedOrigins: [mock.origin],
        printers: [{ printerKey, origin: mock.origin }],
        limits: {
          maxMessageBytes: 65536,
          connectTimeoutMs: 2000,
          requestTimeoutMs: 2000,
          staleAfterMs: 5000,
          reconnectMinMs: 100,
          reconnectMaxMs: 1000,
        },
      },
      onDiagnostic(value) {
        diagnostics.push(value)
      },
      onRawObservation(value) {
        observation = value
      },
    })
    void collect.catch(() => {})
    try {
      await expect
        .poll(() => observation?.status?.print_stats.state)
        .toBe('standby')
      const [farmId, agentId, assignmentId, appId, grantId, cmdId, jobId] =
        Array.from({ length: 7 }, () => randomUUID()) as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      const issuer = await crypto.subtle.generateKey('Ed25519', false, [
        'sign',
        'verify',
      ])
      const clock = { wallNow: Date.now, monotonicNow: () => performance.now() }
      const authority = createOfflineAuthority()
      const wall = clock.wallNow()
      authority.confirm({ wall, mono: clock.monotonicNow() }, 1)
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
      const reports: ReturnType<typeof decodeApiEnvelopeResultFrame>[] = []
      const runner = createApiCommandRunner({
        farmId,
        agentId,
        keys: { issuer: () => issuer.publicKey },
        grants: {
          lookup: () => ({
            grant_id: grantId,
            app_id: appId,
            farm_id: farmId,
            scopes: ['jobs:start'],
            revoked: false,
          }),
          freshness: authority.freshness,
        },
        journal,
        signal: abort.signal,
        clock,
        printer: () => binding,
        observe: () =>
          observation
            ? {
                ready: observation.status?.webhooks.state === 'ready',
                printState: observation.printer.state,
              }
            : null,
        driver: {
          controls: () => ['start_print'],
          macros: () => [],
          async execute(_action, args, { beforeSend, signal }) {
            if (!beforeSend()) return { acknowledged: false }
            const response = await fetch(`${mock.origin}/printer/print/start`, {
              method: 'POST',
              body: JSON.stringify({ filename: args.file }),
              signal,
            })
            await response.text()
            return { acknowledged: response.ok && outcome !== 'uncertain' }
          },
        },
        report(wire) {
          reports.push(decodeApiEnvelopeResultFrame(wire))
        },
        jobFiles: {
          directory: join(directory, 'staging'),
          ca: cert,
          targetFor: () => ({ backend: 'moonraker', origin: mock.origin }),
        },
      })
      const envelope = await signApiEnvelope(
        {
          v: 1,
          purpose: 'api-envelope',
          issuer: API_ENVELOPE_ISSUER,
          kid: 'api-1',
          app_id: appId,
          grant_id: grantId,
          farm_id: farmId,
          agent_id: agentId,
          assignment_id: assignmentId,
          cmd_id: cmdId,
          resource_id: jobId,
          nonce: newApiEnvelopeNonce(),
          issued_at: wall,
          expires_at: wall + 60_000,
          kind: 'job',
          job: {
            file_url: `https://localhost:${address.port}/file`,
            sha256: createHash('sha256').update(file).digest('hex'),
            size_bytes: file.length,
            display_name: 'part.gcode',
          },
        },
        issuer.privateKey,
      )
      const wire = encodeApiEnvelopeFrame({
        v: 1,
        t: 'api-envelope.command',
        envelope,
      })
      expect((await runner.run(wire)).kind).toBe(
        outcome === 'uncertain' ? 'outcome-unknown' : 'completed',
      )
      expect(reports.map(({ outcome }) => outcome)).toEqual(
        outcome === 'uncertain' ? [] : ['started'],
      )
      await expect
        .poll(() => observation?.status?.print_stats.state)
        .toBe('printing')
      mock.control.update({
        state: terminal,
        progress: terminal === 'complete' ? 1 : 0.5,
      })
      const snapshots = () =>
        queue
          .batch(Date.now())
          .records.flatMap((record) =>
            record.kind === 'printer-state' ? [record.state] : [],
          )
      await expect
        .poll(() => snapshots().at(-1)?.lastJob?.outcome)
        .toBe(outcome === 'uncertain' ? 'completed' : outcome)
      const last = snapshots().at(-1)?.lastJob
      expect(last?.filename).toBe('part.gcode')
      // A print error remains visible until Klipper returns to standby.
      if (terminal === 'error') mock.control.update({ state: 'standby' })
      await expect.poll(() => snapshots().at(-1)?.state).toBe('idle')
      expect(diagnostics).not.toContainEqual({
        kind: 'unavailable',
        reason: 'invalid-response',
      })
      expect((await runner.run(wire)).kind).toBe('dropped')
      if (outcome === 'uncertain') {
        expect(reports).toEqual([])
        return
      }
      expect(reports.map((report) => report.outcome)).toEqual([
        'started',
        outcome,
      ])
      const final = reports[1]!
      expect(final).toMatchObject({ cmd_id: cmdId, at: last?.endedAt })

      let storedDetail: unknown
      const delivery = new PostgresIntegrationJobDelivery((async (
        _query: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        if (values.length === 0) return []
        storedDetail = values[3]
        expect(values[4]).toBeNull()
        return []
      }) as unknown as Sql)
      await delivery.transition(cmdId, ['started'], outcome, Date.now(), {
        historyEntryId: final.history_entry_id!,
      })
      expect(storedDetail).toBe(`telemetry-ended-at:${last?.endedAt}`)
      const list = Object.assign(
        async (_query: TemplateStringsArray, rows: unknown, prefix: string) => {
          expect(rows).toEqual([
            {
              id: '17',
              farm: farmId,
              printer: assignmentId,
              agent: agentId,
              outcome,
              ended: String(last?.endedAt),
            },
            {
              id: '16',
              farm: farmId,
              printer: assignmentId,
              agent: agentId,
              outcome,
              ended: String(last!.endedAt - 1),
            },
          ])
          return storedDetail === prefix + last?.endedAt
            ? [{ id: '17', jobId }]
            : []
        },
        { json: (value: unknown) => value },
      ) as unknown as Sql
      const historyRow = {
        id: '17',
        farmId,
        printerId: assignmentId,
        agentId,
        outcome,
        filename: last?.filename,
        endedAt: last?.endedAt,
        printDurationSeconds: null,
        totalDurationSeconds: null,
        filamentUsage: null,
      }
      const page = await listIntegrationJobs(
        (async () => [
          historyRow,
          { ...historyRow, id: '16', endedAt: last!.endedAt - 1 },
        ]) as unknown as Sql,
        {
          farmWideFarmIds: [farmId],
          assignmentIds: [],
          printerId: null,
          since: null,
          until: null,
          limit: 50,
          cursor: null,
        },
        list,
      )
      expect(page.data[0]).toMatchObject({ id: '17', jobId, outcome })
      expect(page.data[1]).not.toHaveProperty('jobId')
    } finally {
      abort.abort()
      try {
        await collect
      } finally {
        queue.close()
        closeCommandJournal(journal)
        source.closeAllConnections()
        await Promise.all([
          new Promise<void>((resolve) => source.close(() => resolve())),
          mock.close(),
        ])
        await rm(directory, { recursive: true, force: true })
        for (const id of [directory, mock.origin, address.port])
          recordResource(id, 'removed')
      }
    }
  },
)
