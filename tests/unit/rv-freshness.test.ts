import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sql, TransactionSql } from 'postgres'
import { expect, test, vi } from 'vitest'
import {
  TelemetryBatch,
  type SpoolInventory,
} from '@open3dfarmmanager/farm-protocol'
import { renderFarmComponent } from '../helpers/render-farm-component.ts'
import { durableTelemetryEvent } from '../../apps/farm/server/storage/postgres-telemetry.ts'
import { freshAdvertisedActions } from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import { OBSERVATION_FRESH_MS } from '../../apps/farm/server/utils/integration-telemetry.ts'
import {
  hasCurrentSpoolObservation,
  prefetchSpoolMembership,
} from '../../apps/farm/server/storage/postgres-inventory-snapshot.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'

const serviceId = '00000000-0000-4000-8000-000000000001'
const farmId = '00000000-0000-4000-8000-000000000002'
const binding = { serviceId, spoolId: 99 }
const spool = {
  spoolId: 99,
  name: 'PLA Azul',
  material: 'PLA',
  colorHex: '2463eb',
  remainingGrams: 500,
  location: null,
  archived: false,
}
const inventory: SpoolInventory = {
  serviceId,
  observedAt: 1_000,
  stale: false,
  total: 1,
  spools: [spool],
}

test('#872 drains backlog with per-attempt age that cannot refresh spool binding or advertised controls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rv-freshness-'))
  const queue = new TelemetryQueue(dir, 1_000)
  const controls = ['pause'] as const
  const dbNow = 123_000_000
  try {
    queue.enqueueInventory(inventory, 1_000)
    queue.enqueue(
      {
        printerKey: 'simulator',
        observedAt: 1_000,
        state: 'printing',
        progress: 0.5,
        controls: [...controls],
      },
      1_000,
    )
    const send = vi.fn(async (body: string) => {
      return TelemetryBatch.parse(JSON.parse(body)).map(
        ({ eventId }) => eventId,
      )
    })
    const signal = new AbortController().signal
    expect(
      (
        await drainTelemetryOnce(
          queue,
          async (body) => {
            await send(body)
            return []
          },
          () => OBSERVATION_FRESH_MS + 2_000,
          signal,
        )
      ).status,
    ).toBe('retained')
    expect(
      (
        await drainTelemetryOnce(
          queue,
          send,
          () => OBSERVATION_FRESH_MS + 3_000,
          signal,
        )
      ).status,
    ).toBe('delivered')

    const first = TelemetryBatch.parse(JSON.parse(send.mock.calls[0]![0]))
    const second = TelemetryBatch.parse(JSON.parse(send.mock.calls[1]![0]))
    expect(second.map(durableTelemetryEvent)).toEqual(
      first.map(durableTelemetryEvent),
    )
    expect(first).toMatchObject([
      { ageAtSendMs: OBSERVATION_FRESH_MS + 1_000 },
      { ageAtSendMs: OBSERVATION_FRESH_MS + 1_000 },
    ])
    const [snapshot, state] = second
    if (
      snapshot?.kind !== 'inventory-snapshot' ||
      state?.kind !== 'printer-state'
    )
      throw new Error('Unexpected telemetry order')
    expect(snapshot.ageAtSendMs).toBe(OBSERVATION_FRESH_MS + 2_000)
    expect(
      freshAdvertisedActions(controls, state.ageAtSendMs, dbNow, dbNow),
    ).toEqual([])
    const row = {
      agentId: 'agent',
      observedAt: inventory.observedAt,
      receivedAt: dbNow,
      databaseNow: dbNow,
      ageAtSendMs: snapshot.ageAtSendMs,
      snapshot: inventory,
      revision: '1',
    }
    const tx = vi
      .fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([{ ...row, ageAtSendMs: 1 }])
    expect(
      await hasCurrentSpoolObservation(
        tx as unknown as TransactionSql,
        farmId,
        binding,
      ),
    ).toBe(false)
    expect(
      await hasCurrentSpoolObservation(
        tx as unknown as TransactionSql,
        farmId,
        binding,
      ),
    ).toBe(true)
    expect(freshAdvertisedActions(controls, 1, dbNow, dbNow)).toEqual(controls)
  } finally {
    queue.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('#874 skips offline inboxes and queries the newest eligible Connector first', async () => {
  const snapshot = { ...inventory, total: 1, spools: [] }
  const rows = Array.from({ length: 9 }, (_, index) => ({
    agentId: String(index),
    observedAt: snapshot.observedAt,
    receivedAt: 100 + index,
    databaseNow: 120,
    ageAtSendMs: 0,
    snapshot,
    revision: '1',
  }))
  const sql = vi.fn(async () => rows)
  const read = vi.fn((agentId: string) => {
    if (Number(agentId) < 3 || agentId === '7') return undefined
    return Promise.resolve({
      kind: 'spool-membership',
      ...binding,
      present: agentId === '8',
      observedAt: snapshot.observedAt,
    })
  })
  expect(
    await prefetchSpoolMembership(sql as unknown as Sql, farmId, binding, read),
  ).toEqual([{ agentId: '8', revision: '1', repliedAt: expect.any(Number) }])
  expect(read.mock.calls.map(([id]) => id)).toEqual(['8', '7', '6', '5', '4'])
})

test('#887 hides Spoolman materials when a non-historical observation expires', async () => {
  const render = (mono: number) =>
    renderFarmComponent('../SpoolInventory.vue', {
      items: [
        {
          agentId: 'agent',
          received: { wall: 1000, mono: 10 },
          historical: false,
          inventory,
        },
      ],
      now: { wall: 1000, mono },
      connected: true,
      rows: [],
    })
  const fresh = await render(11)
  expect(fresh).toContain('PLA Azul')
  expect(fresh).toContain('/spool-art/')
  const stale = await render(30_010)
  expect(stale).toContain('Desatualizado.')
  expect(stale).not.toContain('PLA Azul')
  expect(stale).not.toContain('/spool-art/')
})

test('#887 renders load-slot choices only while the underlying materials are fresh', async () => {
  const render = (mono: number) =>
    renderFarmComponent('../FarmMacrosControls.vue', {
      row: {
        assignment: { printerKey: 'simulador' },
        connection: 'authenticated',
        observation: {
          historical: false,
          received: { wall: 1000, mono: 10 },
          state: {
            controls: ['load_filament'],
            materials: [{ slot: 'ams:1:2', materialType: 'PLA Azul' }],
          },
        },
      },
      keys: { kind: 'unavailable' },
      controlEnabled: false,
      commandInFlight: false,
      now: { wall: 1000, mono },
    })
  const fresh = await render(11)
  expect(fresh).toContain('Bandeja AMS')
  expect(fresh).toContain('value="6"')
  expect(fresh).toContain('PLA Azul')
  const stale = await render(30_010)
  expect(stale).not.toContain('Bandeja AMS')
  expect(stale).not.toContain('PLA Azul')
})
