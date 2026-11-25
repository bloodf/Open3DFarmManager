import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import { expect, test, vi } from 'vitest'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { prefetchSpoolMembership } from '../../apps/farm/server/storage/postgres-inventory-snapshot.ts'
import { projectHistory } from '../../apps/farm/server/utils/integration-telemetry.ts'
import { printerReadiness } from '../../apps/farm/server/utils/integration-printers-readiness.ts'

const serviceId = '00000000-0000-4000-8000-000000000001'
const binding = { serviceId, spoolId: 99 }

test('backward wall clock step cannot reduce queued duration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rv-904-'))
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
  const wallClock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const queue = new TelemetryQueue(dir, 1000)
  try {
    queue.enqueue(
      { printerKey: 'simulator', observedAt: 1000, state: 'idle', progress: 0 },
      1000,
    )
    clock.mockReturnValue(12100)
    wallClock.mockReturnValue(500)
    let age: number | undefined
    const send = async (body: string) => {
      const [record] = JSON.parse(body)
      age = record.ageAtSendMs
      return [record.eventId]
    }
    expect(
      await drainTelemetryOnce(
        queue,
        send,
        () => Date.now(),
        new AbortController().signal,
      ),
    ).toMatchObject({ status: 'uncertain', reason: 'queue' })
    expect(age).toBeUndefined()
    wallClock.mockReturnValue(1000)
    await drainTelemetryOnce(
      queue,
      send,
      () => Date.now(),
      new AbortController().signal,
    )
    expect(age).toBe(12000)
  } finally {
    queue.close()
    clock.mockRestore()
    wallClock.mockRestore()
    await rm(dir, { recursive: true, force: true })
  }
})

test('future observations do not expose invented times in readiness or timeline', () => {
  const state = { printerKey: 'simulator', observedAt: 2000, state: 'printing' }
  const readiness = printerReadiness(
    {
      id: 'id',
      farmId: 'farm',
      agentId: 'agent',
      printerKey: 'simulator',
      displayName: 'Simulator',
      groupName: null,
      location: null,
      sandbox: false,
      state,
      observedAt: 2000,
    },
    1000,
  )
  expect(readiness.observedAt).toBeNull()
  expect(readiness.eligible).toBe(false)
  expect(projectHistory([{ state }], 0, 1000)).toEqual({
    metrics: [],
    intervals: [{ from: 0, until: 1000, state: 'gap' }],
  })
})

test('queries the fifth available Connector after the first batch declines', async () => {
  const snapshot = {
    serviceId,
    observedAt: 1000,
    stale: false,
    total: 1,
    spools: [],
  }
  const rows = Array.from({ length: 5 }, (_, i) => ({
    agentId: String(i),
    observedAt: 1000,
    receivedAt: 100 + i,
    databaseNow: 110,
    ageAtSendMs: 0,
    snapshot,
    revision: '1',
  }))
  const sql = vi.fn(async () => rows)
  const read = vi.fn((agentId: string) =>
    Promise.resolve({
      kind: 'spool-membership',
      ...binding,
      present: agentId === '0',
      observedAt: 1000,
    }),
  )
  expect(
    await prefetchSpoolMembership(sql as unknown as Sql, 'farm', binding, read),
  ).toEqual([{ agentId: '0', revision: '1', repliedAt: expect.any(Number) }])
  expect(read).toHaveBeenCalledTimes(5)
})
