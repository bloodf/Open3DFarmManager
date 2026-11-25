import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'

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
