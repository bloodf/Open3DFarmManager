import { setTimeout as delay } from 'node:timers/promises'
import type { PrinterState } from '../../../farm-protocol/src/state.ts'
import type { RawPrinterObservation } from '../runtime/farm-snapshot-provider.ts'
import { READ_ONLY_POLL_MS } from '../runtime/snapshot-window.ts'
import { Binding, PHOTON_P1_MAX, type PhotonResinBinding } from './config.ts'
import { createPhotonResinAdapter } from './index.ts'
import type { PhotonResinSession } from './session.ts'
import { photonResinStatus } from './status.ts'

/** The open session of each printer, shared with signed control and camera. */
export type PhotonResinSessions = Map<string, PhotonResinSession>

/**
 * The broker takes one client with the issued ID, so reopening at once would
 * keep displacing Photon Workshop.
 */
export const PHOTON_RESIN_RECONNECT_MS = 30_000
/** Bounds one broker reply, and keeps a stop inside the dispatch deadline. */
const REPLY_TIMEOUT_MS = 2000

export function createPhotonResinCollection(input: {
  binding: PhotonResinBinding
  allowedOrigins: readonly string[]
  signal: AbortSignal
  timeoutMs: number
  sessions?: PhotonResinSessions
  pollMs?: number
  reconnectMs?: number
  onObservation: (observation: RawPrinterObservation) => void
  onUnavailable: (epoch: number) => void
  /** A write became possible or stopped being possible. */
  onCapabilitiesChange?: () => void
}) {
  const { signal } = input
  const binding = Binding.parse(input.binding)
  if (!input.allowedOrigins.includes(binding.origin))
    throw Error('Anycubic resin origin is not allowlisted')
  const origin = new URL(binding.origin)
  const sessions = input.sessions ?? new Map<string, PhotonResinSession>()
  const adapter = createPhotonResinAdapter({
    host: origin.hostname,
    port: Number(origin.port || 80),
    timeoutMs: Math.min(input.timeoutMs, 5000),
  })
  const statusReason = binding.simulated
    ? 'anycubic-resin-simulated'
    : 'anycubic-resin-unqualified'
  const { printerKey } = binding
  let epoch = 1
  let unavailable = false
  let capabilities = ''

  function changed(next: string) {
    if (next === capabilities) return
    capabilities = next
    input.onCapabilitiesChange?.()
  }

  async function publish(session: PhotonResinSession) {
    const polled = Date.now()
    const mono = performance.now()
    const state = await session.refresh()
    if (signal.aborted) return
    if (!state.connected || !state.printer || state.printer.observedAt < polled)
      throw Error('Photon session returned no current status')
    const { stoppableJob, ...status } = photonResinStatus(state, Date.now())
    const printer: PrinterState = {
      printerKey,
      ...status,
      // The cited exchanges report no firmware version.
      identity: { vendor: 'Anycubic', model: PHOTON_P1_MAX },
      statusReason,
      controls: [],
      observedAt: Date.now(),
    }
    input.onObservation({
      printerKey,
      epoch,
      printer,
      receivedAtMonoMs: performance.now(),
      fieldObservedAtMonoMs: {
        anycubicResin: Object.fromEntries(
          [
            'state',
            'identity',
            'statusReason',
            ...(
              ['filename', 'progress', 'currentLayer', 'totalLayer'] as const
            ).filter((field) => printer[field] !== undefined),
          ].map((field) => [field, mono]),
        ),
      },
    })
    unavailable = false
    changed(stoppableJob ? 'stoppable' : '')
  }

  async function run() {
    while (!signal.aborted) {
      let session: PhotonResinSession | undefined
      try {
        session = await adapter.openSession({
          serial: binding.expect.serial,
          pinSha256: binding.pinSha256,
          ...(binding.brokerPort ? { brokerPort: binding.brokerPort } : {}),
          ...(binding.cameraPort ? { cameraPort: binding.cameraPort } : {}),
          commandTimeoutMs: REPLY_TIMEOUT_MS,
          signal,
        })
        sessions.set(printerKey, session)
        while (!signal.aborted) {
          await publish(session)
          await delay(input.pollMs ?? READ_ONLY_POLL_MS, undefined, { signal })
        }
      } catch {
        if (!signal.aborted && !unavailable) {
          unavailable = true
          input.onUnavailable(epoch++)
        }
      } finally {
        sessions.delete(printerKey)
        session?.close()
        changed('')
      }
      try {
        await delay(input.reconnectMs ?? PHOTON_RESIN_RECONNECT_MS, undefined, {
          signal,
        })
      } catch (error) {
        if (!signal.aborted) throw error
      }
    }
  }

  return { done: run() }
}
