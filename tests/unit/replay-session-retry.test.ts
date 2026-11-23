// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest'
import {
  sendLibraryReplay,
  type ReplayControl,
} from '../../apps/farm/app/utils/replay-live'
import { replayOutcomeText } from '../../apps/farm/app/utils/replay-view'
import type { FarmPauseControlState } from '../../apps/farm/app/utils/webrtc/farm-pause-control'

const args = { sha256: 'a'.repeat(64) }
const session = (
  outcome: Awaited<ReturnType<ReplayControl['issueControlCommand']>>,
): ReplayControl => ({
  issueControlCommand: vi.fn(async () => outcome),
  close: vi.fn(),
  dispose: vi.fn(async () => {}),
})

describe('replay session retry', () => {
  it('opens a fresh session after a pre-send close and sends once', async () => {
    const sent = session('applied')
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('File session closed'))
      .mockResolvedValueOnce(sent)
    const result = await sendLibraryReplay(connect, args)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(sent.issueControlCommand).toHaveBeenCalledTimes(1)
    expect(replayOutcomeText(result)).toContain('Impressão iniciada')
  })

  it('does not retry a refusal with a reason', async () => {
    const connect = vi.fn(
      async (onState: (state: FarmPauseControlState) => void) => ({
        ...session('not-sent'),
        issueControlCommand: async () => {
          onState({
            kind: 'settled',
            outcome: 'rejected',
            code: 'checksum-mismatch',
          })
          return 'not-sent' as const
        },
      }),
    )
    expect(await sendLibraryReplay(connect, args)).toEqual({
      outcome: 'not-sent',
      code: 'checksum-mismatch',
    })
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('does not retry an unknown outcome', async () => {
    const connect = vi.fn(async () => session('outcome-unknown'))
    expect(await sendLibraryReplay(connect, args)).toEqual({
      outcome: 'outcome-unknown',
    })
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('reports a clear error after three unsent attempts', async () => {
    const connect = vi.fn(async () => session(undefined))
    const result = await sendLibraryReplay(connect, args)
    expect(connect).toHaveBeenCalledTimes(3)
    expect(replayOutcomeText(result)).toContain(
      'O comando não foi enviado ao Connector',
    )
  })
})
