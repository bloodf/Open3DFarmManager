import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { decodeApiEnvelopeResultFrame } from '../../packages/farm-protocol/src/api-envelope.ts'
import type { RawMoonrakerObservation } from '../../packages/connector/src/moonraker/subscription.ts'
import { openApiJobLifecycle } from '../../packages/connector/src/runtime/api-job-lifecycle.ts'

const sentAt = 100_000
const printerKey = 'fixture'
const filename = 'same.gcode'

function observation(
  state: RawMoonrakerObservation['status']['print_stats']['state'],
  elapsed: number,
  options: { duration?: number; jobId?: string } = {},
): RawMoonrakerObservation {
  return {
    printerKey,
    epoch: 1,
    printer: { printerKey, state: 'idle', observedAt: sentAt + elapsed },
    status: {
      webhooks: { state: 'ready' },
      print_stats: {
        state,
        filename,
        total_duration: options.duration,
        info: { job_id: options.jobId },
      },
      virtual_sdcard: { progress: 0 },
    },
    fieldObservedAtMonoMs: { webhooks: 0, printState: elapsed, progress: 0 },
    receivedAtMonoMs: elapsed,
  }
}

test.each([
  ['a start error', observation('error', 2)],
  ['a run predating dispatch', observation('printing', 2, { duration: 30 })],
  [
    'a different Moonraker job ID',
    observation('printing', 2, { jobId: 'manual' }),
  ],
] as const)(
  'a later run cannot claim the API job after %s',
  async (_, invalid) => {
    const apiJobs = openApiJobLifecycle()
    const cmdId = randomUUID()
    const reports: ReturnType<typeof decodeApiEnvelopeResultFrame>[] = []
    apiJobs.attach(async (wire) => {
      reports.push(decodeApiEnvelopeResultFrame(wire))
    })
    apiJobs.watch(printerKey, filename, cmdId, sentAt, 0).confirm()
    if (
      invalid.status.print_stats.state === 'printing' &&
      invalid.status.print_stats.total_duration === undefined
    )
      apiJobs.observe(observation('printing', 1, { jobId: 'api' }))
    apiJobs.observe(invalid)
    apiJobs.observe(observation('printing', 100))
    apiJobs.record({
      printerKey,
      state: 'idle',
      observedAt: sentAt + 200,
      lastJob: { filename, outcome: 'completed', endedAt: sentAt + 200 },
    })
    await expect.poll(() => reports.length).toBe(2)
    expect(reports).toEqual([
      {
        v: 1,
        t: 'api-envelope.result',
        cmd_id: cmdId,
        outcome: 'started',
        at: sentAt,
      },
      {
        v: 1,
        t: 'api-envelope.result',
        cmd_id: cmdId,
        outcome: 'failed',
        detail: 'outcome-unknown',
        at: sentAt + 2,
      },
    ])
  },
)
