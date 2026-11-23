import { describe, expect, it } from 'vitest'
import type { TransactionSql } from 'postgres'
import { recordJobs } from '../../apps/farm/server/storage/job-history-store.ts'

const scope = { farmId: 'farm', agentId: 'agent' }
const usage = [{ tool: 'extruder', grams: 12.5 }]

describe('job history filament usage storage', () => {
  it('binds filament usage as a structured jsonb array and preserves absent usage', async () => {
    const parameters: unknown[][] = []
    const tx = Object.assign(
      async (_parts: TemplateStringsArray, ...values: unknown[]) => {
        parameters.push(values)
      },
      { json: (value: unknown) => ({ type: 3802, value }) },
    ) as unknown as TransactionSql

    await recordJobs(tx, scope, [
      {
        printerKey: 'p1',
        outcome: 'completed',
        endedAt: 1,
        filamentUsage: usage,
      },
      { printerKey: 'p2', outcome: 'failed', endedAt: 2 },
    ])

    // postgres.js serializes the raw value in its jsonb parameter once.
    expect(parameters[0]?.[7]).toEqual({ type: 3802, value: usage })
    expect(parameters[1]?.[7]).toBeNull()
  })
})
