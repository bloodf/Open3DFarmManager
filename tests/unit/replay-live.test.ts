// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import {
  liveReplayIndex,
  liveReplayInfo,
  sendLibraryReplay,
  type ReplayControl,
} from '../../apps/farm/app/utils/replay-live'
import type { FarmKeyState, FarmRow } from '../../apps/farm/app/utils/farm-view'
import type { FarmPauseControlState } from '../../apps/farm/app/utils/webrtc/farm-pause-control'

const NOW = { wall: 1_000_000, mono: 5_000 }
const keys: FarmKeyState = {
  kind: 'available',
  choices: [{ keyId: 'k', thumbprint: 't' }],
  selected: 'k',
}
const row = (
  printerKey: string,
  over: {
    state?: string
    connection?: FarmRow['connection']
    controls?: string[]
  } = {},
): FarmRow =>
  ({
    assignment: {
      assignmentId: `${printerKey}-id`,
      agentId: 'agent',
      printerKey,
      status: 'active',
      connectorStatus: 'approved',
    },
    connection: over.connection ?? 'authenticated',
    localOrigin: null,
    observation: {
      state: {
        printerKey,
        state: over.state ?? 'idle',
        ...(over.controls ? { controls: over.controls } : {}),
        identity: { vendor: 'bambu' },
        materials: [{ slot: '0', materialType: 'PLA', colorHex: 'FF0000FF' }],
      },
      received: NOW,
      sourceClockComparable: true,
      historical: false,
    },
  }) as unknown as FarmRow

describe('liveReplayInfo', () => {
  it('reports a live idle printer with its backend and loaded materials', () => {
    expect(liveReplayInfo(row('x1c'), keys, true, NOW)).toEqual({
      connectorOnline: true,
      live: true,
      state: 'idle',
      backend: 'bambu',
      materials: [{ slot: '0', materialType: 'PLA', colorHex: 'FF0000FF' }],
    })
  })

  it('is not live without a direct connection or with control disabled', () => {
    expect(
      liveReplayInfo(row('a', { connection: 'closed' }), keys, true, NOW).live,
    ).toBe(false)
    expect(liveReplayInfo(row('a'), keys, false, NOW).live).toBe(false)
    expect(liveReplayInfo(row('a'), { kind: 'loading' }, true, NOW).live).toBe(
      false,
    )
  })

  it('requires the advertised start print capability for library replay', () => {
    expect(
      liveReplayInfo(row('a', { controls: ['start_print'] }), keys, true, NOW)
        .live,
    ).toBe(true)
    expect(
      liveReplayInfo(row('a', { controls: ['pause'] }), keys, true, NOW).live,
    ).toBe(false)
  })

  it('marks an offline printer so the dialog says the Connector is offline', () => {
    const info = liveReplayInfo(row('a', { state: 'offline' }), keys, true, NOW)
    expect(info.connectorOnline).toBe(false)
    expect(info.live).toBe(false)
  })
})

describe('liveReplayIndex', () => {
  it('indexes rows by printer key, first row winning', () => {
    const index = liveReplayIndex(
      [row('a'), row('b'), row('a', { state: 'printing' })],
      keys,
      true,
      NOW,
    )
    expect([...index.keys()]).toEqual(['a', 'b'])
    expect(index.get('a')?.state).toBe('idle')
  })
})

describe('sendLibraryReplay', () => {
  const args = { sha256: 'a'.repeat(64) }
  const control = (
    outcome: Awaited<ReturnType<ReplayControl['issueControlCommand']>> | Error,
    log: string[] = [],
  ): ReplayControl => ({
    issueControlCommand: async (action, sent) => {
      log.push(`${action}:${sent.sha256.slice(0, 4)}`)
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    close: () => void log.push('close'),
    dispose: async () => void log.push('dispose'),
  })

  it('sends one signed start_library_print and closes the session', async () => {
    const log: string[] = []
    await expect(
      sendLibraryReplay(async () => control('applied', log), args),
    ).resolves.toEqual({ outcome: 'applied' })
    expect(log).toEqual(['start_library_print:aaaa', 'close', 'dispose'])
  })

  it('carries the Connector refusal code of a rejected command', async () => {
    const result = await sendLibraryReplay(async (onState) => {
      const settled: FarmPauseControlState = {
        kind: 'settled',
        outcome: 'rejected',
        code: 'checksum-mismatch',
      }
      return {
        ...control('rejected'),
        issueControlCommand: async () => {
          onState(settled)
          return 'rejected' as const
        },
      }
    }, args)
    expect(result).toEqual({ outcome: 'rejected', code: 'checksum-mismatch' })
  })

  it('sends nothing when the session never gets ready', async () => {
    await expect(
      sendLibraryReplay(async () => {
        throw new Error('File session closed')
      }, args),
    ).resolves.toEqual({ outcome: 'not-sent' })
  })

  it('reports an unsent command as not sent and a failure mid-send as unknown', async () => {
    await expect(
      sendLibraryReplay(async () => control(undefined), args),
    ).resolves.toEqual({ outcome: 'not-sent' })
    const log: string[] = []
    await expect(
      sendLibraryReplay(async () => control(new Error('rtc'), log), args),
    ).resolves.toEqual({ outcome: 'outcome-unknown' })
    expect(log).toContain('dispose')
  })
})
