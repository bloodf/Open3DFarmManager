import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TransactionSql } from 'postgres'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { parseCollectorConfig } from '../../packages/connector/src/formlabs/config.ts'
import { recordLatestStates } from '../../apps/farm/server/storage/postgres-printer-latest-state.ts'
import { listIntegrationPrinters } from '../../apps/farm/server/utils/integration-printers.ts'
import { submitIntegrationActionRequest } from '../../apps/farm/server/utils/integration-actions-http.ts'
import { freshWorld, ids } from '../helpers/api-v1-contract/world.ts'
import type { PrinterState } from '../../packages/farm-protocol/src/state.ts'

test('simulated print telemetry stores advertised controls for listing and actions', async () => {
  const sim = await startMoonrakerMock()
  const directory = mkdtempSync(join(tmpdir(), 'fix-670-controls-'))
  const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
  const controller = new AbortController()
  const done = collectIntoQueue({
    config: parseCollectorConfig({
      version: 1,
      allowedOrigins: [sim.origin],
      printers: [{ printerKey: 'printer-a1', origin: sim.origin }],
      limits: {},
    }),
    queue,
    signal: controller.signal,
    onDiagnostic() {},
    controlsFor: () => ['pause', 'cancel'],
  })
  const world = freshWorld()
  const app = world.addApp([
    {
      printerId: ids.printerA1,
      scopes: ['printers:read', 'control:basic', 'control:extended'],
    },
  ])
  const principal = {
    appId: app.appId,
    scopes: ['printers:read', 'control:basic', 'control:extended'] as const,
    grants: world.authStore.grants.filter((grant) => grant.appId === app.appId),
  }
  const row = world.authStore.printers.find(
    (printer) => printer.id === ids.printerA1,
  )!
  let stored: PrinterState | undefined
  const tx = Object.assign(
    async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      stored = values[4] as PrinterState
      return []
    },
    { json: (value: unknown) => value },
  ) as unknown as TransactionSql
  async function capture(state: PrinterState['state'], after = -1) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const events = queue.batch(Date.now()).records
      const event = events.findLast(
        (entry) =>
          entry.kind === 'printer-state' &&
          entry.state.state === state &&
          entry.state.observedAt > after,
      )
      if (event) {
        await recordLatestStates(
          tx,
          { farmId: ids.farmA, agentId: ids.agentA },
          [event],
        )
        expect(stored?.state).toBe(state)
        expect(stored?.controls).toEqual(['pause', 'cancel'])
        row.state = structuredClone(stored)
        world.actionsStore.targets.set(ids.printerA1, {
          farmId: ids.farmA,
          agentId: ids.agentA,
          controls: stored!.controls ?? null,
        })
        const listed = await listIntegrationPrinters(
          principal,
          { readPrinters: async () => [row], readPrinter: async () => row },
          new URLSearchParams(),
        )
        expect('data' in listed && listed.data[0]?.controls).toEqual([
          'pause',
          'cancel',
        ])
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw Error(`No ${state} telemetry`)
  }
  try {
    await capture('idle')
    sim.control.update({
      state: 'printing',
      filename: 'part.gcode',
      progress: 0.2,
    })
    await capture('printing')
    for (const action of ['pause', 'cancel', 'resume']) {
      const response = await submitIntegrationActionRequest(
        new Request('http://localhost/actions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `key-${action}`,
          },
          body: JSON.stringify({ action, args: {} }),
        }),
        principal,
        ids.printerA1,
        world.actions,
      )
      expect(response.status).toBe(action === 'resume' ? 422 : 202)
      if (action === 'resume')
        expect(await response.json()).toMatchObject({ code: 'unsupported' })
    }
    expect(
      [...world.envelopes.commands.values()].map(
        (command) => command.kind === 'action' && command.action.action,
      ),
    ).toEqual(['pause', 'cancel'])
    const printingAt = stored!.observedAt
    sim.control.completePrint()
    await capture('idle', printingAt)
  } finally {
    controller.abort()
    await done
    queue.close()
    await sim.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 15000)
