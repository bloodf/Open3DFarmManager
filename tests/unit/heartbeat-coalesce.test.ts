import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'

test('drains a day of heartbeats with the latest health', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'heartbeat-coalesce-'))
  const now = Date.now()
  const queue = new TelemetryQueue(directory, now)
  try {
    for (let i = 0; i < 1440; i++) {
      queue.enqueueHeartbeat(
        {
          connector: {
            version: '1.0.0',
            uptimeMs: i,
            queueBacklog: i,
            storage: 'healthy',
            rtcScope: 'lan',
          },
          printers: [],
        },
        now + i,
      )
    }
    const received: unknown[] = []
    let uploads = 0
    while (queue.depth) {
      const result = await drainTelemetryOnce(
        queue,
        async (body) => {
          uploads++
          const records = JSON.parse(body)
          received.push(...records)
          return records.map((record: { eventId: string }) => record.eventId)
        },
        () => now + 1440,
        new AbortController().signal,
      )
      expect(result.status).toBe('delivered')
    }
    expect(uploads).toBeLessThanOrEqual(3)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      kind: 'heartbeat',
      health: { connector: { uptimeMs: 1439, queueBacklog: 1439 } },
    })
  } finally {
    queue.close()
    for (const file of readdirSync(directory)) unlinkSync(join(directory, file))
    rmdirSync(directory)
  }
}, 30000)
