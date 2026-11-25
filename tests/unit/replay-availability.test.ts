// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest'
import {
  checkReplayConnection,
  replayWithFreshAvailability,
} from '../../apps/farm/app/utils/replay-availability'
import type { ReplayControl } from '../../apps/farm/app/utils/replay-live'
import {
  disabledReason,
  replayOutcomeText,
  type ReplayPrinter,
  type ReplaySource,
} from '../../apps/farm/app/utils/replay-view'

const args = { sha256: 'a'.repeat(64) }
const session = (admittedActions = ['start_library_print']) => {
  const control = {
    admittedActions,
    issueControlCommand: vi.fn(async () => 'applied' as const),
    close: vi.fn(),
    dispose: vi.fn(async () => {}),
  }
  return control satisfies ReplayControl
}
const always = () => true

describe('stale live availability', () => {
  it('waits for fresh availability before opening a session', async () => {
    let live = false
    setTimeout(() => (live = true), 20)
    const control = session()
    const connect = vi.fn(async () => {
      expect(live).toBe(true)
      return control
    })
    const result = await replayWithFreshAvailability({
      isLive: () => live,
      current: always,
      connect,
      args,
    })
    expect(result).toEqual({ outcome: 'applied' })
    expect(control.issueControlCommand).toHaveBeenCalledOnce()
  })

  it('opens nothing when the data never becomes fresh', async () => {
    const connect = vi.fn(async () => session())
    const result = await replayWithFreshAvailability({
      isLive: () => false,
      current: always,
      connect,
      args,
      waitMs: 1,
    })
    expect(result).toEqual({ outcome: 'not-sent', code: 'availability-stale' })
    expect(connect).not.toHaveBeenCalled()
    expect(replayOutcomeText(result)).toContain('desatualizada')
    expect(replayOutcomeText(result)).not.toContain('negociação')
  })

  it('admits again when the capability lacks the library start', async () => {
    const old = session(['pause'])
    const fresh = session()
    const connect = vi
      .fn()
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(fresh)
    const result = await replayWithFreshAvailability({
      isLive: always,
      current: always,
      connect,
      args,
    })
    expect(result).toEqual({ outcome: 'applied' })
    expect(old.issueControlCommand).not.toHaveBeenCalled()
    expect(old.dispose).toHaveBeenCalledOnce()
    expect(fresh.issueControlCommand).toHaveBeenCalledOnce()
  })

  it('reports stale availability when no capability ever covers it', async () => {
    const control = session(['pause'])
    const result = await replayWithFreshAvailability({
      isLive: always,
      current: always,
      connect: async () => control,
      args,
    })
    expect(result).toEqual({ outcome: 'not-sent', code: 'availability-stale' })
    expect(control.issueControlCommand).not.toHaveBeenCalled()
  })

  it('tells stale data apart from a missing connection in the list', () => {
    const source = { storageLocation: 'server' } as ReplaySource
    const printer = { connectorOnline: true, live: false } as ReplayPrinter
    expect(disabledReason(source, { ...printer, stale: true })).toContain(
      'desatualizados',
    )
    expect(disabledReason(source, printer)).toContain('conexão direta')
    // A held plate is not a lost connection.
    expect(disabledReason(source, { ...printer, held: true })).toContain(
      'Confirmar placa livre',
    )
  })
})

describe('session handshake failure', () => {
  const failed = async (): Promise<ReplayControl> => {
    throw Error('File session closed')
  }

  it('names the handshake and sends nothing', async () => {
    const connect = vi.fn(failed)
    const result = await replayWithFreshAvailability({
      isLive: always,
      current: always,
      connect,
      args,
    })
    expect(result).toEqual({
      outcome: 'not-sent',
      code: 'session-handshake-failed',
    })
    expect(replayOutcomeText(result)).toContain('negociação da conexão')
    expect(replayOutcomeText(result)).toContain('A impressão não foi iniciada')
  })

  it('outlasts the gap before the Connector listens again, sending once', async () => {
    vi.useFakeTimers()
    try {
      const control = session()
      const listening = Date.now() + 1_500
      const result = replayWithFreshAvailability({
        isLive: always,
        current: always,
        connect: async () =>
          Date.now() < listening ? await failed() : control,
        args,
      })
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await result).toEqual({ outcome: 'applied' })
      expect(control.issueControlCommand).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries the connection only and never sends a command', async () => {
    const control = session()
    expect(await checkReplayConnection(async () => control)).toBe(true)
    expect(control.issueControlCommand).not.toHaveBeenCalled()
    expect(control.close).toHaveBeenCalledOnce()
    expect(control.dispose).toHaveBeenCalledOnce()
    expect(await checkReplayConnection(failed)).toBe(false)
  })

  it('keeps an uncertain command uncertain, with one send', async () => {
    const control = session()
    control.issueControlCommand.mockRejectedValue(Error('reply lost'))
    const connect = vi.fn(async () => control)
    const result = await replayWithFreshAvailability({
      isLive: always,
      current: always,
      connect,
      args,
    })
    expect(result).toEqual({ outcome: 'outcome-unknown' })
    expect(control.issueControlCommand).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledOnce()
  })
})
