// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest'
import { offlineCards } from '../../apps/farm/app/composables/useLastKnownStates-core.ts'
import {
  configureSpoolmanOnConnectors,
  describeSpoolmanResult,
} from '../../apps/farm/app/utils/spoolman-onboarding.ts'
import { createDetailQueries } from '../../apps/farm/app/utils/webrtc/detail-queries.ts'

const stored = {
  assignmentId: 'assignment-a',
  printerKey: 'printer-a',
  state: 'printing' as const,
  progress: 0.5,
  temperatures: { toolCelsius: undefined, bedCelsius: undefined },
  observedAt: 1,
}

describe('degraded and uncertain states', () => {
  it('keeps stored state for inventory rows without a live observation', () => {
    expect(
      offlineCards(
        [
          {
            assignment: { assignmentId: 'assignment-a' },
            connection: 'closed',
          },
        ],
        [stored],
      ),
    ).toEqual([stored])
  })

  it('reports an unknown outcome when a commit request is rejected', async () => {
    const target = {
      v: 1,
      protocol: 'config-v1',
      backend: 'spoolman',
      model: { family: 'spoolman', provisional: true },
      origin: 'https://spool.example',
    } as const
    const session = {
      advertisedRevision: 1,
      prepare: vi.fn().mockResolvedValue({
        kind: 'prepared',
        targetSha256: 'target',
        receiptSha256: 'receipt',
      }),
      commit: vi.fn().mockRejectedValue(new Error('timeout')),
      cancel: vi.fn(),
      close: vi.fn(),
    }
    const [result] = await configureSpoolmanOnConnectors({
      target,
      agentIds: ['agent-a'],
      openSession: async () => session,
      report: async () => {},
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ outcome: 'unknown' })
    expect(describeSpoolmanResult(result!)).toMatch(
      /resultado.*desconhecido.*verifique.*antes de tentar novamente/i,
    )
    expect(session.cancel).not.toHaveBeenCalled()
  })

  it('retries a transient temperature query after finite backoff', () => {
    let now = 0
    const send = vi.fn()
    const queries = createDetailQueries({
      printerKey: 'printer-a',
      send,
      onResponse: () => {},
      clock: () => now,
    })
    queries.update(['heaters'])
    const first = JSON.parse(send.mock.calls[0]![0])
    queries.receive({
      v: 1,
      t: 'query.response',
      printerKey: 'printer-a',
      requestId: first.requestId,
      kind: 'temperature-store',
      error: 'unavailable',
    })
    now = 60_000
    queries.update(['heaters'])
    expect(send).toHaveBeenCalledTimes(2)
  })
})
